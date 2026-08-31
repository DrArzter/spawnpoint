#!/usr/bin/env bash

# Validate an uploaded mod pack and extract it into a staging directory.
#
# The input is a zip somebody chose, so every entry is treated as hostile until
# it matches: names are checked before extraction rather than after, extraction
# flattens paths so a traversal cannot land anywhere, and the caps below make a
# compression bomb a refusal instead of a full disk. Refusals are cheap; a
# release built from a poisoned archive is not.

set -Eeuo pipefail

usage() {
  cat >&2 <<'EOF'
usage: extract-pack-upload.sh <pack.zip> <new-output-directory>

Environment:
  PACK_MAX_ENTRIES        maximum files in the archive (default 4096)
  PACK_MAX_TOTAL_BYTES    maximum uncompressed total (default 4294967296)
  PACK_MAX_ENTRY_BYTES    maximum uncompressed single file (default 268435456)
  PACK_MOD_EXTENSION      expected mod extension (default jar)
EOF
}

[[ $# -eq 2 ]] || {
  usage
  exit 2
}

archive="$1"
output_dir="$2"
max_entries="${PACK_MAX_ENTRIES:-4096}"
max_total_bytes="${PACK_MAX_TOTAL_BYTES:-4294967296}"
max_entry_bytes="${PACK_MAX_ENTRY_BYTES:-268435456}"
extension="${PACK_MOD_EXTENSION:-jar}"

for command in unzip awk; do
  command -v "${command}" >/dev/null 2>&1 || {
    printf 'error: required command not found: %s\n' "${command}" >&2
    exit 1
  }
done

[[ -f "${archive}" && ! -L "${archive}" ]] || {
  printf 'error: pack must be a regular file: %s\n' "${archive}" >&2
  exit 1
}
[[ ! -e "${output_dir}" && ! -L "${output_dir}" ]] || {
  printf 'error: output directory already exists: %s\n' "${output_dir}" >&2
  exit 1
}

# `unzip -l` is parsed for sizes, and `unzip -Z` for the entry attributes that
# reveal a symlink; neither is trusted to be well behaved on its own.
listing="$(unzip -Z1 -- "${archive}")" || {
  printf 'error: not a readable zip archive: %s\n' "${archive}" >&2
  exit 1
}
attributes="$(unzip -Z -- "${archive}")" || exit 1

if grep -qE '^l' <<<"${attributes}"; then
  printf 'error: the pack contains a symbolic link, which a release never does\n' >&2
  exit 1
fi

entries=0
declare -a names=()
while IFS= read -r entry; do
  [[ -n "${entry}" ]] || continue
  # A directory entry is ignored rather than refused: zip writers add them.
  [[ "${entry}" != */ ]] || continue
  entries=$((entries + 1))
  (( entries <= max_entries )) || {
    printf 'error: the pack holds more than %s files\n' "${max_entries}" >&2
    exit 1
  }
  # One shape, checked before anything is written: an optional single mods/
  # prefix, then a plain file name. No absolute paths, no traversal, no
  # nesting, no surprises.
  [[ "${entry}" =~ ^(mods/)?[A-Za-z0-9][A-Za-z0-9._+-]*\.${extension}$ ]] || {
    printf 'error: unexpected entry in the pack: %s\n' "${entry}" >&2
    printf 'hint: a pack holds %s files, optionally inside a single mods/ directory\n' "${extension}" >&2
    exit 1
  }
  names+=("${entry##*/}")
done <<<"${listing}"

(( entries > 0 )) || {
  printf 'error: the pack contains no %s files\n' "${extension}" >&2
  exit 1
}

# Two entries with the same file name would silently become one release file.
duplicates="$(printf '%s\n' "${names[@]}" | sort | uniq -d)"
[[ -z "${duplicates}" ]] || {
  printf 'error: the pack holds the same file name twice:\n%s\n' "${duplicates}" >&2
  exit 1
}

total_bytes=0
while read -r size name; do
  [[ "${size}" =~ ^[0-9]+$ ]] || continue
  [[ "${name}" != */ ]] || continue
  (( size <= max_entry_bytes )) || {
    printf 'error: %s expands to %s bytes, over the %s limit\n' "${name}" "${size}" "${max_entry_bytes}" >&2
    exit 1
  }
  total_bytes=$((total_bytes + size))
  (( total_bytes <= max_total_bytes )) || {
    printf 'error: the pack expands past the %s byte limit\n' "${max_total_bytes}" >&2
    exit 1
  }
done < <(unzip -l -- "${archive}" | awk 'NF >= 4 && $1 ~ /^[0-9]+$/ { print $1, $NF }')

# -j flattens, so even an entry that slipped the checks cannot land outside the
# staging directory; -o is safe because duplicate names were already refused.
mkdir -p -- "${output_dir}"
unzip -q -j -o -- "${archive}" -d "${output_dir}" >/dev/null

extracted="$(find "${output_dir}" -maxdepth 1 -type f -name "*.${extension}" | wc -l | tr -d ' ')"
[[ "${extracted}" == "${entries}" ]] || {
  printf 'error: extracted %s files but the listing promised %s\n' "${extracted}" "${entries}" >&2
  exit 1
}
if find "${output_dir}" -mindepth 1 \( -type l -o ! -type f \) -print -quit | grep -q .; then
  printf 'error: extraction produced an unexpected filesystem entry\n' >&2
  exit 1
fi

printf 'result=extracted\n'
printf 'mods=%s\n' "${entries}"
printf 'bytes=%s\n' "${total_bytes}"
printf 'output=%s\n' "${output_dir}"
