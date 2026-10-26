#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_profiles.sh
source "${SCRIPT_DIR}/_profiles.sh"

readonly DEFAULT_RESOLVER_IMAGE="itzg/minecraft-server@sha256:7423a4cf59ec510a58294f853fc7b07cdf0a50c5bc4618ee172327d7913941eb"

usage() {
  cat >&2 <<'EOF'
usage: resolve-profile-mods.sh <profile-directory> <new-output-directory>

The profile's game (ADR-0034) selects the resolver. Minecraft profiles default to individual CurseForge files through
the pinned mc-image-helper image and may select curseforge-modpack for one pinned client/server archive pair.
Factorio resolves portal pins through games/factorio/resolve-mods.sh. Absence means minecraft.

Environment:
  CF_API_KEY       CurseForge Eternal API key; minecraft profiles only
  PROFILE_ENV_FILE Optional dotenv file from which only CF_API_KEY is read
  RESOLVER_IMAGE   Digest-pinned image containing mc-image-helper
  FACTORIO_USERNAME, FACTORIO_TOKEN
                   factorio.com credentials; factorio profiles with pins only

A Minecraft profile of CurseForge files may add mods.server_only and mods.client_only (ADR-0069): lists in the same
format, resolved the same way. The server gets source plus server_only in the output directory; players get source plus
client_only, written beside it as client-mods/.

The output path must not exist. Downloads happen in a sibling staging directory and become visible only after every
download succeeds. An empty-mod profile creates an empty output without contacting any mod source.
EOF
}

[[ $# -eq 2 ]] || {
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
output_directory="$(realpath -m -- "$2")"
output_parent="$(dirname -- "${output_directory}")"
profile="${profile_directory}/profile.json"
resolver_image="${RESOLVER_IMAGE:-${DEFAULT_RESOLVER_IMAGE}}"

[[ -f "${profile}" && ! -L "${profile}" ]] || {
  printf 'error: profile.json must be a regular non-symlink file: %s\n' "${profile}" >&2
  exit 1
}
[[ ! -e "${output_directory}" && ! -L "${output_directory}" ]] || {
  printf 'error: immutable resolver output already exists: %s\n' "${output_directory}" >&2
  exit 1
}
mkdir -p -- "${output_parent}"
[[ -d "${output_parent}" && ! -L "${output_parent}" ]] || {
  printf 'error: output parent must be a regular directory\n' >&2
  exit 1
}

git_root="$(git -C "${profile_directory}" rev-parse --show-toplevel)"
profile_relative="$(realpath --relative-to="${git_root}" -- "${profile_directory}")"
[[ -z "$(git -C "${git_root}" status --porcelain --untracked-files=all -- "${profile_relative}")" ]] || {
  printf 'error: source profile has uncommitted changes: %s\n' "${profile_relative}" >&2
  exit 1
}

game="$(profile_game "${profile}")"
profile_game_facts "${game}"
validate_profile_metadata "${profile}"

profile_id="$(jq -r '.id' "${profile}")"
[[ "${profile_id}" == "$(basename -- "${profile_directory}")" ]] || {
  printf 'error: profile id must match its directory name\n' >&2
  exit 1
}
game_version="$(jq -r --arg field "${PROFILE_VERSION_FIELD}" '.[$field]' "${profile}")"
loader_type="$(jq -r '.loader.type' "${profile}")"
mods_source="$(jq -r '.mods.source // empty' "${profile}")"
mods_resolver="$(jq -r '.mods.resolver // empty' "${profile}")"
[[ -n "${mods_resolver}" ]] || mods_resolver="${PROFILE_RESOLVER}"
server_only_list="$(jq -r '.mods.server_only // empty' "${profile}")"
client_only_list="$(jq -r '.mods.client_only // empty' "${profile}")"

stage="$(mktemp -d "${output_parent}/.$(basename -- "${output_directory}").stage.XXXXXXXX")"
download_stage="${stage}/download"
resolved_stage="${stage}/resolved"
mkdir -p -- "${download_stage}" "${resolved_stage}"
cleanup() {
  if [[ -n "${stage:-}" && "$(dirname -- "${stage}")" == "${output_parent}" ]]; then
    rm -rf -- "${stage}"
  fi
  if [[ "${sidecars_moved:-false}" == true ]]; then
    rm -rf -- "${output_parent}/overrides" "${output_parent}/client.zip" "${output_parent}/client-mods"
  fi
}
trap cleanup EXIT

# A list the profile names, as a path inside the profile: never a symlink, never
# outside it, since its directory is what the resolver container mounts.
checked_list() {
  local relative="$1" candidate file
  candidate="${profile_directory}/${relative}"
  [[ ! -L "${candidate}" ]] || {
    printf 'error: profile mod list must not be a symlink: %s\n' "${candidate}" >&2
    exit 1
  }
  file="$(realpath -e -- "${candidate}")"
  [[ "${file}" == "${profile_directory}/"* && -f "${file}" ]] || {
    printf 'error: profile mod list is missing or unsafe: %s\n' "${file}" >&2
    exit 1
  }
  realpath --relative-to="${profile_directory}" -- "${file}"
}

# Individual CurseForge files through the pinned mc-image-helper, into <stage>/mods.
resolve_curseforge_files() {
  local list="$1" target="$2"
  mkdir -p -- "${target}"
  docker run --rm \
    --user "$(id -u):$(id -g)" \
    --env CF_API_KEY \
    --volume "${profile_directory}:/profile:ro" \
    --volume "${target}:/output" \
    --entrypoint mc-image-helper \
    "${resolver_image}" \
    curseforge-files \
      --disable-api-caching \
      --game-version "${game_version}" \
      --mod-loader "${loader_type}" \
      --output-directory /output \
      "@/profile/${list}"
}

# Adds one side list's resolved mods to a set. A file both already carry with
# the same bytes is a shared dependency and stays once; the same name with other
# bytes is two different mods, which no folder can hold.
merge_side_list() {
  local label="$1" from="$2" into="$3" mod filename added=0
  [[ -d "${from}" && ! -L "${from}" ]] || {
    printf 'error: the %s list did not produce its mods directory\n' "${label}" >&2
    exit 1
  }
  while IFS= read -r -d '' mod; do
    filename="$(basename -- "${mod}")"
    if [[ -e "${into}/${filename}" ]]; then
      [[ "$(sha256sum -- "${mod}" | awk '{print $1}')" == "$(sha256sum -- "${into}/${filename}" | awk '{print $1}')" ]] || {
        printf 'error: the %s list resolves %s to other bytes than the mods it joins\n' "${label}" "${filename}" >&2
        exit 1
      }
      continue
    fi
    mv -- "${mod}" "${into}/${filename}"
    added=$((added + 1))
  done < <(find "${from}" -maxdepth 1 -type f -name "*.${PROFILE_MOD_EXTENSION}" -print0)
  (( added > 0 )) || {
    printf 'error: the %s list adds no mod the set does not already have\n' "${label}" >&2
    exit 1
  }
}

if [[ -n "${mods_source}" ]]; then
  mods_source="$(checked_list "${mods_source}")"
  source_file="${profile_directory}/${mods_source}"
  [[ -z "${server_only_list}" ]] || server_only_list="$(checked_list "${server_only_list}")"
  [[ -z "${client_only_list}" ]] || client_only_list="$(checked_list "${client_only_list}")"

  case "${mods_resolver}" in
  curseforge-files | curseforge-modpack)
    cf_api_key="${CF_API_KEY:-}"
    if [[ -z "${cf_api_key}" && -n "${PROFILE_ENV_FILE:-}" ]]; then
      env_file="$(realpath -e -- "${PROFILE_ENV_FILE}")"
      [[ -f "${env_file}" && ! -L "${env_file}" ]] || {
        printf 'error: PROFILE_ENV_FILE must be a regular non-symlink file\n' >&2
        exit 1
      }
      cf_api_key="$(awk -F= '$1 == "CF_API_KEY" { print substr($0, index($0, "=") + 1); found = 1; exit } END { if (!found) exit 1 }' "${env_file}")" || {
        printf 'error: PROFILE_ENV_FILE does not contain CF_API_KEY\n' >&2
        exit 1
      }
      cf_api_key="${cf_api_key%$'\r'}"
      if [[ "${cf_api_key}" == \'*\' && "${cf_api_key}" == *\' ]]; then
        cf_api_key="${cf_api_key:1:${#cf_api_key}-2}"
      elif [[ "${cf_api_key}" == \"*\" && "${cf_api_key}" == *\" ]]; then
        cf_api_key="${cf_api_key:1:${#cf_api_key}-2}"
      fi
    fi
    [[ -n "${cf_api_key}" ]] || {
      printf 'error: CF_API_KEY or PROFILE_ENV_FILE is required for %s\n' "${profile_id}" >&2
      exit 1
    }
    export CF_API_KEY="${cf_api_key}"
    if [[ "${mods_resolver}" == "curseforge-files" ]]; then
      command -v docker >/dev/null 2>&1 || {
        printf 'error: required command not found: docker\n' >&2
        exit 1
      }
      resolve_curseforge_files "${mods_source}" "${download_stage}"
    else
      modpack_resolver="${SCRIPT_DIR}/resolve-curseforge-modpack.sh"
      [[ -f "${modpack_resolver}" ]] || {
        printf 'error: CurseForge modpack resolution needs %s, which this bundle does not carry\n' "${modpack_resolver}" >&2
        exit 1
      }
      rm -rf -- "${download_stage}"
      loader_version="$(jq -r '.loader.version' "${profile}")"
      CURSEFORGE_EXPECTED_MINECRAFT_VERSION="${game_version}" \
      CURSEFORGE_EXPECTED_LOADER_TYPE="${loader_type}" \
      CURSEFORGE_EXPECTED_LOADER_VERSION="${loader_version}" \
        bash "${modpack_resolver}" "${source_file}" "${download_stage}" >&2
    fi
    ;;
  factorio-portal)
    # The portal resolver is a game module, not a container: pins in, verified
    # zips out, credentials enforced by itself and only when a pin needs a
    # download.
    portal_resolver="${SCRIPT_DIR}/../games/factorio/resolve-mods.sh"
    [[ -f "${portal_resolver}" ]] || {
      printf 'error: factorio resolution needs %s, which this bundle does not carry\n' "${portal_resolver}" >&2
      exit 1
    }
    FACTORIO_TARGET_VERSION="${game_version}" \
      bash "${portal_resolver}" "${source_file}" "${download_stage}" >&2
    ;;
  *)
    printf 'error: no resolver for %s\n' "${mods_resolver}" >&2
    exit 1
    ;;
  esac

  # Every resolver writes into <stage>/mods, whatever its transport.
  downloaded_mods="${download_stage}/mods"
  [[ -d "${downloaded_mods}" && ! -L "${downloaded_mods}" ]] || {
    printf 'error: the %s resolver did not produce its mods directory\n' "${mods_resolver}" >&2
    exit 1
  }
  while IFS= read -r -d '' mod; do
    filename="$(basename -- "${mod}")"
    [[ ! -e "${resolved_stage}/${filename}" ]] || {
      printf 'error: resolver produced a duplicate filename: %s\n' "${filename}" >&2
      exit 1
    }
    mv -- "${mod}" "${resolved_stage}/${filename}"
  done < <(find "${downloaded_mods}" -maxdepth 1 -type f -name "*.${PROFILE_MOD_EXTENSION}" -print0)

  mod_count="$(find "${resolved_stage}" -maxdepth 1 -type f -name "*.${PROFILE_MOD_EXTENSION}" | wc -l)"
  (( mod_count > 0 )) || {
    printf 'error: %s resolution produced zero %s files for %s\n' \
      "${mods_resolver}" "${PROFILE_MOD_EXTENSION}" "${profile_id}" >&2
    exit 1
  }

  # Side lists (ADR-0069): players get every mod both sides share plus their
  # own; the server gets its own on top. Validation admitted them for
  # CurseForge files only.
  client_mod_count=0
  if [[ -n "${server_only_list}${client_only_list}" ]]; then
    client_stage="${stage}/client-mods"
    mkdir -p -- "${client_stage}"
    find "${resolved_stage}" -maxdepth 1 -type f -name "*.${PROFILE_MOD_EXTENSION}" -exec cp -p -- {} "${client_stage}/" \;
    if [[ -n "${server_only_list}" ]]; then
      resolve_curseforge_files "${server_only_list}" "${stage}/server-only"
      merge_side_list server_only "${stage}/server-only/mods" "${resolved_stage}"
      mod_count="$(find "${resolved_stage}" -maxdepth 1 -type f -name "*.${PROFILE_MOD_EXTENSION}" | wc -l)"
    fi
    if [[ -n "${client_only_list}" ]]; then
      resolve_curseforge_files "${client_only_list}" "${stage}/client-only"
      merge_side_list client_only "${stage}/client-only/mods" "${client_stage}"
    fi
    client_mod_count="$(find "${client_stage}" -maxdepth 1 -type f -name "*.${PROFILE_MOD_EXTENSION}" | wc -l)"
    [[ ! -e "${output_parent}/client-mods" && ! -L "${output_parent}/client-mods" ]] || {
      printf 'error: immutable resolver client mods already exist: %s\n' "${output_parent}/client-mods" >&2
      exit 1
    }
    mv -- "${client_stage}" "${output_parent}/client-mods"
    sidecars_moved=true
  fi

  if [[ "${mods_resolver}" == "curseforge-modpack" ]]; then
    overrides_source="${download_stage}/overrides"
    client_source="${download_stage}/client.zip"
    [[ -d "${overrides_source}" && ! -L "${overrides_source}" ]] || {
      printf 'error: CurseForge modpack resolver produced no overrides directory\n' >&2
      exit 1
    }
    [[ -f "${client_source}" && ! -L "${client_source}" ]] || {
      printf 'error: CurseForge modpack resolver produced no client pack\n' >&2
      exit 1
    }
    [[ ! -e "${output_parent}/overrides" && ! -L "${output_parent}/overrides" ]] || {
      printf 'error: immutable resolver overrides already exist: %s\n' "${output_parent}/overrides" >&2
      exit 1
    }
    [[ ! -e "${output_parent}/client.zip" && ! -L "${output_parent}/client.zip" ]] || {
      printf 'error: immutable resolver client pack already exists: %s\n' "${output_parent}/client.zip" >&2
      exit 1
    }
    mv -- "${overrides_source}" "${output_parent}/overrides"
    mv -- "${client_source}" "${output_parent}/client.zip"
    sidecars_moved=true
  fi
else
  mod_count=0
  client_mod_count=0
fi

if find "${resolved_stage}" -mindepth 1 -maxdepth 1 \( -type l -o ! -type f \) -print -quit | grep -q .; then
  printf 'error: resolver produced an unsafe filesystem entry\n' >&2
  exit 1
fi

total_bytes="$(find "${resolved_stage}" -maxdepth 1 -type f -name "*.${PROFILE_MOD_EXTENSION}" -printf '%s\n' | awk '{sum += $1} END {print sum + 0}')"
mv -T -- "${resolved_stage}" "${output_directory}"
rm -rf -- "${stage}"
stage=""
sidecars_moved=false
trap - EXIT

printf 'result=resolved\n'
printf 'profile_id=%s\n' "${profile_id}"
printf 'game=%s\n' "${game}"
printf 'mods=%s\n' "${mod_count}"
printf 'client_mods=%s\n' "${client_mod_count}"
printf 'bytes=%s\n' "${total_bytes}"
printf 'output=%s\n' "${output_directory}"
