#!/usr/bin/env bash

set -Eeuo pipefail

readonly DEFAULT_RESOLVER_IMAGE="itzg/minecraft-server@sha256:7423a4cf59ec510a58294f853fc7b07cdf0a50c5bc4618ee172327d7913941eb"

usage() {
  cat >&2 <<'EOF'
usage: resolve-profile-mods.sh <profile-directory> <new-output-directory>

Environment:
  CF_API_KEY       CurseForge Eternal API key; preferred when already exported
  PROFILE_ENV_FILE Optional dotenv file from which only CF_API_KEY is read
  RESOLVER_IMAGE   Digest-pinned image containing mc-image-helper

The output path must not exist. Downloads happen in a sibling staging directory and become visible only after every
download succeeds. An empty-mod profile creates an empty output without contacting CurseForge.
EOF
}

[[ $# -eq 2 ]] || {
  usage
  exit 2
}

for command in docker git jq realpath; do
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

jq -e '
  .schema_version == 1 and
  (.id | type == "string" and test("^[a-z0-9][a-z0-9-]{0,31}$")) and
  (.minecraft_version | type == "string" and length > 0) and
  .loader.type == "forge" and
  (.loader.version | type == "string" and length > 0) and
  (.mods.source == null or (.mods.source | type == "string" and length > 0))
' "${profile}" >/dev/null || {
  printf 'error: unsupported or invalid profile metadata: %s\n' "${profile}" >&2
  exit 1
}

profile_id="$(jq -r '.id' "${profile}")"
[[ "${profile_id}" == "$(basename -- "${profile_directory}")" ]] || {
  printf 'error: profile id must match its directory name\n' >&2
  exit 1
}
minecraft_version="$(jq -r '.minecraft_version' "${profile}")"
loader_type="$(jq -r '.loader.type' "${profile}")"
mods_source="$(jq -r '.mods.source // empty' "${profile}")"

stage="$(mktemp -d "${output_parent}/.$(basename -- "${output_directory}").stage.XXXXXXXX")"
download_stage="${stage}/download"
resolved_stage="${stage}/resolved"
mkdir -p -- "${download_stage}" "${resolved_stage}"
cleanup() {
  if [[ -n "${stage:-}" && "$(dirname -- "${stage}")" == "${output_parent}" ]]; then
    rm -rf -- "${stage}"
  fi
}
trap cleanup EXIT

if [[ -n "${mods_source}" ]]; then
  source_candidate="${profile_directory}/${mods_source}"
  [[ ! -L "${source_candidate}" ]] || {
    printf 'error: profile mod source must not be a symlink: %s\n' "${source_candidate}" >&2
    exit 1
  }
  source_file="$(realpath -e -- "${source_candidate}")"
  [[ "${source_file}" == "${profile_directory}/"* && -f "${source_file}" ]] || {
    printf 'error: profile mod source is missing or unsafe: %s\n' "${source_file}" >&2
    exit 1
  }
  mods_source="$(realpath --relative-to="${profile_directory}" -- "${source_file}")"

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
  docker run --rm \
    --user "$(id -u):$(id -g)" \
    --env CF_API_KEY \
    --volume "${profile_directory}:/profile:ro" \
    --volume "${download_stage}:/output" \
    --entrypoint mc-image-helper \
    "${resolver_image}" \
    curseforge-files \
      --disable-api-caching \
      --game-version "${minecraft_version}" \
      --mod-loader "${loader_type}" \
      --output-directory /output \
      "@/profile/${mods_source}"

  downloaded_mods="${download_stage}/mods"
  [[ -d "${downloaded_mods}" && ! -L "${downloaded_mods}" ]] || {
    printf 'error: CurseForge resolver did not produce its mods directory\n' >&2
    exit 1
  }
  while IFS= read -r -d '' jar; do
    filename="$(basename -- "${jar}")"
    [[ ! -e "${resolved_stage}/${filename}" ]] || {
      printf 'error: resolver produced a duplicate JAR filename: %s\n' "${filename}" >&2
      exit 1
    }
    mv -- "${jar}" "${resolved_stage}/${filename}"
  done < <(find "${downloaded_mods}" -maxdepth 1 -type f -name '*.jar' -print0)

  jar_count="$(find "${resolved_stage}" -maxdepth 1 -type f -name '*.jar' | wc -l)"
  (( jar_count > 0 )) || {
    printf 'error: CurseForge resolution produced zero JARs for %s\n' "${profile_id}" >&2
    exit 1
  }
else
  jar_count=0
fi

if find "${resolved_stage}" -mindepth 1 -maxdepth 1 \( -type l -o ! -type f \) -print -quit | grep -q .; then
  printf 'error: resolver produced an unsafe filesystem entry\n' >&2
  exit 1
fi

total_bytes="$(find "${resolved_stage}" -maxdepth 1 -type f -name '*.jar' -printf '%s\n' | awk '{sum += $1} END {print sum + 0}')"
mv -T -- "${resolved_stage}" "${output_directory}"
rm -rf -- "${stage}"
stage=""
trap - EXIT

printf 'result=resolved\n'
printf 'profile_id=%s\n' "${profile_id}"
printf 'mods=%s\n' "${jar_count}"
printf 'bytes=%s\n' "${total_bytes}"
printf 'output=%s\n' "${output_directory}"
