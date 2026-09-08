#!/usr/bin/env bash

set -Eeuo pipefail

usage() {
  cat >&2 <<'EOF'
usage: build-release-manifest.sh <release> <minecraft-version> <loader-version> <mods-directory> <output-manifest>

Environment:
  RELEASE_CREATED_BY  Identity recorded in the release (default: local-operator)
  RELEASE_CHANGELOG   Short release description (default: Baseline release)
  RELEASE_PROFILE_ID, RELEASE_PROFILE_REPOSITORY, RELEASE_PROFILE_COMMIT
                      Optional all-or-nothing provenance for a source profile
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
# The game decides the mod file extension and loader.type; the version
# argument carries that game's version. Absent means minecraft, so every
# existing caller keeps its exact pre-axis behaviour.
release_game="${RELEASE_GAME:-minecraft}"
case "${release_game}" in
  minecraft)
    mod_extension="jar"
    loader_type="forge"
    ;;
  factorio)
    mod_extension="zip"
    loader_type="factorio"
    ;;
  zomboid)
    mod_extension="zip"
    loader_type="workshop"
    ;;
  *)
    printf 'error: unknown RELEASE_GAME: %s\n' "${release_game}" >&2
    exit 1
    ;;
esac
profile_id="${RELEASE_PROFILE_ID:-}"
profile_repository="${RELEASE_PROFILE_REPOSITORY:-}"
profile_commit="${RELEASE_PROFILE_COMMIT:-}"

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
profile_fields=0
[[ -n "${profile_id}" ]] && profile_fields=$((profile_fields + 1))
[[ -n "${profile_repository}" ]] && profile_fields=$((profile_fields + 1))
[[ -n "${profile_commit}" ]] && profile_fields=$((profile_fields + 1))
[[ "${profile_fields}" == 0 || "${profile_fields}" == 3 ]] || {
  printf 'error: profile provenance must provide id, repository and commit together\n' >&2
  exit 1
}
if (( profile_fields == 3 )); then
  [[ "${profile_id}" =~ ^[a-z0-9][a-z0-9-]{0,31}$ ]] || {
    printf 'error: invalid source profile id: %s\n' "${profile_id}" >&2
    exit 1
  }
  [[ "${profile_commit}" =~ ^[0-9a-f]{40}$ ]] || {
    printf 'error: source profile commit must be a full lowercase Git SHA\n' >&2
    exit 1
  }
fi
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
done < <(find "${mods_dir}" -maxdepth 1 -type f -name "*.${mod_extension}" -print0 | sort -z)

jq -s \
  --arg release "${release}" \
  --arg minecraft_version "${minecraft_version}" \
  --arg loader_version "${loader_version}" \
  --arg created_at "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" \
  --arg created_by "${created_by}" \
  --arg changelog "${changelog}" \
  --arg game "${release_game}" \
  --arg loader_type "${loader_type}" \
  --arg profile_id "${profile_id}" \
  --arg profile_repository "${profile_repository}" \
  --arg profile_commit "${profile_commit}" \
  '({
    schema_version: 1,
    game: $game,
    release: $release,
    minecraft_version: $minecraft_version,
    loader: {type: $loader_type, version: $loader_version},
    created_at: $created_at,
    created_by: $created_by,
    changelog: $changelog,
    server: {mods: .}
  } + if $profile_id == "" then {} else {
    source_profile: {
      id: $profile_id,
      repository: $profile_repository,
      commit: $profile_commit
    }
  } end)' "${entries_file}" >"${output_tmp}"

chmod 0644 "${output_tmp}"
mv -- "${output_tmp}" "${output_manifest}"
printf 'result=manifest_created\n'
printf 'release=%s\n' "${release}"
printf 'manifest=%s\n' "${output_manifest}"
printf 'mods=%d\n' "${count}"
