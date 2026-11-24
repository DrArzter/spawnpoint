#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_profiles.sh
source "${SCRIPT_DIR}/_profiles.sh"

usage() {
  cat >&2 <<'EOF'
usage: build-profile-release.sh <profile-directory> <release> <resolved-mods-directory> <output-manifest>

The profile must belong to a clean Git checkout, or PROFILE_SOURCE_REPOSITORY and PROFILE_SOURCE_COMMIT must identify
its verified Git snapshot. Its origin URL, full commit and profile ID are embedded in the release manifest. A profile
with mods.source=null requires an empty resolved mod directory. The profile's game
(ADR-0034) selects the version field, the loader contract and the mod extension; absence means the legacy game (ADR-0089).
A profile with mods.addons (ADR-0077) needs the resolver's addons/ beside the mods: this step adds them to the client
pack, whose version becomes <upstream>+<release>, and records them in client.addons and mod_index.
EOF
}

[[ $# -eq 4 ]] || {
  usage
  exit 2
}

for command in jq realpath; do
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

if [[ -n "${PROFILE_SOURCE_REPOSITORY:-}" || -n "${PROFILE_SOURCE_COMMIT:-}" ]]; then
  [[ -n "${PROFILE_SOURCE_REPOSITORY:-}" && "${PROFILE_SOURCE_COMMIT:-}" =~ ^[0-9a-f]{40}$ ]] || {
    printf 'error: verified snapshot source requires repository and full commit\n' >&2
    exit 1
  }
  profile_repository="${PROFILE_SOURCE_REPOSITORY}"
  profile_commit="${PROFILE_SOURCE_COMMIT}"
else
  command -v git >/dev/null 2>&1 || {
    printf 'error: required command not found: git\n' >&2
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
fi
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
runtime_image="$(jq -r '.runtime.image // empty' "${profile}")"
loader_type="$(jq -r '.loader.type' "${profile}")"
payload_root="$(dirname -- "${resolved_mods_directory}")"
overrides_directory=""
client_pack=""
client_mods_directory=""
[[ ! -d "${payload_root}/overrides" ]] || overrides_directory="${payload_root}/overrides"
[[ ! -f "${payload_root}/client.zip" ]] || client_pack="${payload_root}/client.zip"
[[ ! -d "${payload_root}/client-mods" ]] || client_mods_directory="${payload_root}/client-mods"
client_addons=""
client_addons_directory=""
mod_index=""
addons_directory="${payload_root}/addons"
if [[ -n "$(jq -r '.mods.addons // empty' "${profile}")" ]]; then
  [[ -d "${addons_directory}" && ! -L "${addons_directory}" && -f "${addons_directory}/addons-lock.json" ]] || {
    printf 'error: profile %s declares addons but the resolver produced no addons directory\n' "${profile_id}" >&2
    exit 1
  }
  [[ -z "${client_pack}" ]] || {
    printf 'error: immutable client pack already exists: %s\n' "${client_pack}" >&2
    exit 1
  }
  client_pack="${payload_root}/client.zip"
  "${SCRIPT_DIR}/extend-client-pack.sh" "${addons_directory}/upstream-client.zip" "${addons_directory}/client" \
    "${addons_directory}/addons-lock.json" "${release}" "${client_pack}" >&2
  client_addons="${addons_directory}/addons-lock.json"
  mod_index="${addons_directory}/mod-index.json"
  # Client-only addons are the only players' files apart from the pack.
  if jq -e 'any(.mods[]; .side == "client")' "${client_addons}" >/dev/null; then
    [[ -n "${client_mods_directory}" ]] || {
      printf 'error: profile %s has client addons but the resolver produced no client-mods\n' "${profile_id}" >&2
      exit 1
    }
    client_addons_directory="${client_mods_directory}"
  else
    [[ -z "${client_mods_directory}" ]] || {
      printf 'error: profile %s has no client addons but client-mods exists\n' "${profile_id}" >&2
      exit 1
    }
  fi
  client_mods_directory=""
else
  [[ ! -e "${addons_directory}" ]] || {
    printf 'error: profile %s declares no addons but addons exists\n' "${profile_id}" >&2
    exit 1
  }
fi
# Players' own mod set exists exactly when the profile declares a side list
# (ADR-0069); either without the other is a resolver output from another profile.
side_lists="$(jq -r '[.mods.server_only, .mods.client_only] | map(select(. != null)) | length' "${profile}")"
if (( side_lists > 0 )); then
  [[ -n "${client_mods_directory}" ]] || {
    printf 'error: profile %s declares side lists but the resolver produced no client-mods\n' "${profile_id}" >&2
    exit 1
  }
else
  [[ -z "${client_mods_directory}" ]] || {
    printf 'error: profile %s declares no side lists but client-mods exists\n' "${profile_id}" >&2
    exit 1
  }
fi
# Every game's manifest carries its version in the minecraft_version field
# (the recorded wart in ADR-0034), and a game that is its own loader repeats
# the engine version there rather than inventing a second vocabulary.
# A bare loader (the game with no mod loader) is versioned by the game itself.
if jq -e --arg loader "${loader_type}" '.bare_loader_types | index($loader) != null' <<<"${PROFILE_RULES}" >/dev/null; then
  loader_version="${game_version}"
elif [[ "${PROFILE_LOADER_VERSIONED}" == true ]]; then
  loader_version="$(jq -r '.loader.version' "${profile}")"
else
  loader_version="${game_version}"
fi

# Where the resolver fetched the mods, for the manifest's descriptive source field.
mod_source=""
mods_resolver="$(jq -r '.mods.resolver // empty' "${profile}")"
case "${mods_resolver:-${PROFILE_RESOLVER}}" in
  curseforge-files | curseforge-modpack) mod_source="curseforge" ;;
esac
[[ -n "${mods_source}" ]] || mod_source=""

RELEASE_GAME="${game}" \
RELEASE_PROFILE_ID="${profile_id}" \
RELEASE_PROFILE_REPOSITORY="${profile_repository}" \
RELEASE_PROFILE_COMMIT="${profile_commit}" \
RELEASE_RUNTIME_IMAGE="${runtime_image}" \
RELEASE_LOADER_TYPE="${loader_type}" \
RELEASE_SERVER_OVERRIDES_DIR="${overrides_directory}" \
RELEASE_CLIENT_PACK="${client_pack}" \
RELEASE_CLIENT_MODS_DIR="${client_mods_directory}" \
RELEASE_CLIENT_ADDONS="${client_addons}" \
RELEASE_CLIENT_ADDONS_DIR="${client_addons_directory}" \
RELEASE_MOD_INDEX="${mod_index}" \
RELEASE_MOD_SOURCE="${mod_source}" \
  "${SCRIPT_DIR}/build-release-manifest.sh" \
    "${release}" \
    "${game_version}" \
    "${loader_version}" \
    "${resolved_mods_directory}" \
    "${output_manifest}"

printf 'profile_id=%s\n' "${profile_id}"
printf 'game=%s\n' "${game}"
printf 'profile_commit=%s\n' "${profile_commit}"
