#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_profiles.sh
source "${SCRIPT_DIR}/_profiles.sh"

usage() {
  cat >&2 <<'EOF'
usage: build-profile-release.sh <profile-directory> <release> <resolved-mods-directory> <output-manifest>

The profile must belong to a clean Git checkout. Its exact origin URL, full commit and profile ID are embedded in the
release manifest. A profile with mods.source=null requires an empty resolved mod directory. The profile's game
(ADR-0034) selects the version field, the loader contract and the mod extension; absence means minecraft.
EOF
}

[[ $# -eq 4 ]] || {
  usage
  exit 2
}

for command in git jq realpath; do
  command -v "${command}" >/dev/null 2>&1 || {
    printf 'error: required command not found: %s\n' "${command}" >&2
    exit 1
  }
done

profile_directory="$(realpath -e -- "$1")"
release="$2"
resolved_mods_directory="$(realpath -e -- "$3")"
output_manifest="$(realpath -m -- "$4")"
profile="${profile_directory}/profile.json"

[[ -f "${profile}" && ! -L "${profile}" ]] || {
  printf 'error: profile.json must be a regular non-symlink file: %s\n' "${profile}" >&2
  exit 1
}
[[ -d "${resolved_mods_directory}" && ! -L "${resolved_mods_directory}" ]] || {
  printf 'error: resolved mods must be a regular directory: %s\n' "${resolved_mods_directory}" >&2
  exit 1
}

git_root="$(git -C "${profile_directory}" rev-parse --show-toplevel)"
profile_relative="$(realpath --relative-to="${git_root}" -- "${profile_directory}")"
[[ "${profile_relative}" != .. && "${profile_relative}" != ../* ]] || {
  printf 'error: profile directory is outside its Git checkout\n' >&2
  exit 1
}
[[ -z "$(git -C "${git_root}" status --porcelain --untracked-files=all -- "${profile_relative}")" ]] || {
  printf 'error: source profile has uncommitted changes: %s\n' "${profile_relative}" >&2
  exit 1
}

profile_commit="$(git -C "${git_root}" rev-parse HEAD)"
profile_repository="$(git -C "${git_root}" remote get-url origin)"
profile_id="$(jq -er '.id' "${profile}")"
[[ "${profile_id}" == "$(basename -- "${profile_directory}")" ]] || {
  printf 'error: profile id must match its directory name\n' >&2
  exit 1
}

game="$(profile_game "${profile}")"
profile_game_facts "${game}"
validate_profile_metadata "${profile}"

mods_source="$(jq -r '.mods.source // empty' "${profile}")"
mod_count="$(find "${resolved_mods_directory}" -maxdepth 1 -type f -name "*.${PROFILE_MOD_EXTENSION}" | wc -l)"
if [[ -n "${mods_source}" ]]; then
  [[ -f "${profile_directory}/${mods_source}" ]] || {
    printf 'error: profile mod source does not exist: %s\n' "${mods_source}" >&2
    exit 1
  }
  (( mod_count > 0 )) || {
    printf 'error: modded profile %s resolved to zero %s files\n' "${profile_id}" "${PROFILE_MOD_EXTENSION}" >&2
    exit 1
  }
else
  (( mod_count == 0 )) || {
    printf 'error: empty-mod profile %s received %s resolved files\n' "${profile_id}" "${mod_count}" >&2
    exit 1
  }
fi

game_version="$(jq -r --arg field "${PROFILE_VERSION_FIELD}" '.[$field]' "${profile}")"
# Every game's manifest carries its version in the minecraft_version field
# (the recorded wart in ADR-0034), and a game that is its own loader repeats
# the engine version there rather than inventing a second vocabulary.
if [[ "${PROFILE_LOADER_VERSIONED}" == true ]]; then
  loader_version="$(jq -r '.loader.version' "${profile}")"
else
  loader_version="${game_version}"
fi

RELEASE_GAME="${game}" \
RELEASE_PROFILE_ID="${profile_id}" \
RELEASE_PROFILE_REPOSITORY="${profile_repository}" \
RELEASE_PROFILE_COMMIT="${profile_commit}" \
  "${SCRIPT_DIR}/build-release-manifest.sh" \
    "${release}" \
    "${game_version}" \
    "${loader_version}" \
    "${resolved_mods_directory}" \
    "${output_manifest}"

printf 'profile_id=%s\n' "${profile_id}"
printf 'game=%s\n' "${game}"
printf 'profile_commit=%s\n' "${profile_commit}"
