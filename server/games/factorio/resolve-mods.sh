#!/usr/bin/env bash

# Resolve a pinned Factorio mod list (<name>:<version> per line) from the mod
# portal into a payload directory. Distribution model B: the portal keeps
# versions, so pins are real, and connecting clients sync the same list from
# the portal themselves — no client pack exists for this game.
#
# The portal's browse API is public; only the download needs credentials
# (FACTORIO_USERNAME and FACTORIO_TOKEN, from factorio.com/profile). The
# server itself never needs an account: credentials are a cut-time concern.
# An empty list resolves to an empty payload without contacting the portal.

set -Eeuo pipefail

list="${1:-}"
output_dir="${2:-}"
[[ -n "${list}" && -n "${output_dir}" ]] || {
  printf 'usage: resolve-mods.sh <mods.list> <output-directory>\n' >&2
  exit 2
}

for command in curl jq sha1sum; do
  command -v "${command}" >/dev/null 2>&1 || {
    printf 'error: required command not found: %s\n' "${command}" >&2
    exit 1
  }
done

api_base="${FACTORIO_API_BASE:-https://mods.factorio.com}"
list="$(realpath -e -- "${list}")"
output_dir="$(realpath -m -- "${output_dir}")"
mkdir -p -- "${output_dir}/mods"

entries=()
while IFS= read -r line; do
  entry="${line%%#*}"
  entry="${entry//[[:space:]]/}"
  [[ -n "${entry}" ]] || continue
  [[ "${entry}" =~ ^([A-Za-z0-9_-]+):([0-9]+(\.[0-9]+)*)$ ]] || {
    printf 'error: unparseable mod list entry: %s\n' "${line}" >&2
    exit 1
  }
  entries+=("${entry}")
done <"${list}"

if (( ${#entries[@]} == 0 )); then
  printf 'result=resolved\n'
  printf 'payload=%s\n' "${output_dir}"
  printf 'resolved=0\n'
  printf 'downloaded=0\n'
  printf 'kept=0\n'
  exit 0
fi

[[ -n "${FACTORIO_USERNAME:-}" && -n "${FACTORIO_TOKEN:-}" ]] || {
  printf 'error: FACTORIO_USERNAME and FACTORIO_TOKEN are required to download mods (factorio.com/profile); the server itself never needs them\n' >&2
  exit 1
}

resolved=0
downloaded=0
kept=0
for entry in "${entries[@]}"; do
  name="${entry%%:*}"
  version="${entry##*:}"

  mod_json="$(curl -fsSL "${api_base}/api/mods/${name}")" || {
    printf 'error: mod portal lookup failed for %s\n' "${name}" >&2
    exit 1
  }
  release="$(jq -ce --arg version "${version}" '[.releases[] | select(.version == $version)][0]' <<<"${mod_json}")" || {
    printf 'error: %s has no release %s on the portal\n' "${name}" "${version}" >&2
    exit 1
  }
  file_name="$(jq -r '.file_name // empty' <<<"${release}")"
  sha1_expected="$(jq -r '.sha1 // empty' <<<"${release}")"
  download_url="$(jq -r '.download_url // empty' <<<"${release}")"
  [[ "${file_name}" =~ ^[A-Za-z0-9][A-Za-z0-9._+-]*\.zip$ ]] || {
    printf 'error: unsafe or non-zip file name from the portal for %s: %s\n' "${entry}" "${file_name}" >&2
    exit 1
  }
  [[ "${sha1_expected}" =~ ^[0-9a-f]{40}$ ]] || {
    printf 'error: no SHA-1 from the portal for %s\n' "${entry}" >&2
    exit 1
  }
  [[ -n "${download_url}" ]] || {
    printf 'error: no download url from the portal for %s\n' "${entry}" >&2
    exit 1
  }

  resolved=$((resolved + 1))
  target="${output_dir}/mods/${file_name}"
  if [[ -f "${target}" && ! -L "${target}" ]]; then
    actual="$(sha1sum -- "${target}")"
    if [[ "${actual%% *}" == "${sha1_expected}" ]]; then
      kept=$((kept + 1))
      continue
    fi
    printf 'cached %s does not match the pinned release; refetching\n' "${file_name}" >&2
    rm -f -- "${target}"
  fi

  fetch_tmp="$(mktemp "${output_dir}/mods/.${file_name}.XXXXXX")"
  curl -fsSL -o "${fetch_tmp}" \
    "${api_base}${download_url}?username=${FACTORIO_USERNAME}&token=${FACTORIO_TOKEN}" || {
    rm -f -- "${fetch_tmp}"
    printf 'error: download failed for %s\n' "${entry}" >&2
    exit 1
  }
  actual="$(sha1sum -- "${fetch_tmp}")"
  [[ "${actual%% *}" == "${sha1_expected}" ]] || {
    rm -f -- "${fetch_tmp}"
    printf 'error: downloaded %s does not match the pinned SHA-1\n' "${file_name}" >&2
    exit 1
  }
  mv -- "${fetch_tmp}" "${target}"
  downloaded=$((downloaded + 1))
done

printf 'result=resolved\n'
printf 'payload=%s\n' "${output_dir}"
printf 'resolved=%s\n' "${resolved}"
printf 'downloaded=%s\n' "${downloaded}"
printf 'kept=%s\n' "${kept}"
