#!/usr/bin/env bash

set -Eeuo pipefail

usage() {
  cat >&2 <<'EOF'
usage: build-release-manifest.sh <release> <minecraft-version> <loader-version> <mods-directory> <output-manifest>

Environment:
  RELEASE_CREATED_BY  Identity recorded in the release (default: local-operator)
  RELEASE_CHANGELOG   Short release description (default: Baseline release)
EOF
}

[[ $# -eq 5 ]] || {
  usage
  exit 2
}

release="$1"
minecraft_version="$2"
loader_version="$3"
mods_dir="$(realpath -e -- "$4")"
output_manifest="$(realpath -m -- "$5")"
created_by="${RELEASE_CREATED_BY:-local-operator}"
changelog="${RELEASE_CHANGELOG:-Baseline release}"

command -v jq >/dev/null 2>&1 || {
  printf 'error: required command not found: jq\n' >&2
  exit 1
}
command -v sha256sum >/dev/null 2>&1 || {
  printf 'error: required command not found: sha256sum\n' >&2
  exit 1
}
[[ -d "${mods_dir}" ]] || {
  printf 'error: mods directory does not exist: %s\n' "${mods_dir}" >&2
  exit 1
}
[[ "${release}" =~ ^[0-9]+\.[0-9]+$ ]] || {
  printf 'error: release must use MAJOR.MINOR: %s\n' "${release}" >&2
  exit 1
}
[[ ! -e "${output_manifest}" && ! -L "${output_manifest}" ]] || {
  printf 'error: immutable release manifest already exists: %s\n' "${output_manifest}" >&2
  exit 1
}

mkdir -p -- "$(dirname -- "${output_manifest}")"
entries_file="$(mktemp)"
output_tmp="$(mktemp "$(dirname -- "${output_manifest}")/.manifest.XXXXXX")"
cleanup() {
  rm -f -- "${entries_file}" "${output_tmp}"
}
trap cleanup EXIT

count=0
while IFS= read -r -d '' mod; do
  filename="$(basename -- "${mod}")"
  [[ "${filename}" != *$'\n'* && "${filename}" != *$'\t'* ]] || {
    printf 'error: mod filename contains a tab or newline: %q\n' "${filename}" >&2
    exit 1
  }

  sha256="$(sha256sum -- "${mod}")"
  sha256="${sha256%% *}"
  bytes="$(stat --format '%s' -- "${mod}")"
  jq -cn \
    --arg file "${filename}" \
    --arg sha256 "${sha256}" \
    --argjson bytes "${bytes}" \
    '{file: $file, sha256: $sha256, bytes: $bytes}' >>"${entries_file}"
  count=$((count + 1))
done < <(find "${mods_dir}" -maxdepth 1 -type f -name '*.jar' -print0 | sort -z)

(( count > 0 )) || {
  printf 'error: no JAR files found in %s\n' "${mods_dir}" >&2
  exit 1
}

jq -s \
  --arg release "${release}" \
  --arg minecraft_version "${minecraft_version}" \
  --arg loader_version "${loader_version}" \
  --arg created_at "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" \
  --arg created_by "${created_by}" \
  --arg changelog "${changelog}" \
  '{
    schema_version: 1,
    release: $release,
    minecraft_version: $minecraft_version,
    loader: {type: "forge", version: $loader_version},
    created_at: $created_at,
    created_by: $created_by,
    changelog: $changelog,
    server: {mods: .}
  }' "${entries_file}" >"${output_tmp}"

chmod 0644 "${output_tmp}"
mv -- "${output_tmp}" "${output_manifest}"
printf 'result=manifest_created\n'
printf 'release=%s\n' "${release}"
printf 'manifest=%s\n' "${output_manifest}"
printf 'mods=%d\n' "${count}"
