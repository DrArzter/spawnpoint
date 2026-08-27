#!/usr/bin/env bash

# CodeBuild entrypoint for producing an immutable release candidate. The
# buildspec embeds this repository's reviewed helper scripts at Terraform apply
# time; the only Git checkout performed here is the profile repository, which
# is treated strictly as data and never executed.

set -Eeuo pipefail

repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
server_scripts="${repository_root}/server/scripts"
# No default authoring repository: with one repository per game, a default is a
# silent choice of game, and the profile it resolves might even exist in the
# other repository. CF_API_KEY is checked later instead, after the profile is
# read: it is a minecraft-only requirement, and the game is a property of the
# profile (ADR-0034).
for variable in CONFIG_COMMIT PROFILE_ID RELEASE RELEASE_BUCKET CONFIG_REPOSITORY_URL; do
  [[ -n "${!variable:-}" && "${!variable}" != "REQUIRED_BY_CALLER" ]] || {
    printf 'error: %s is required\n' "${variable}" >&2
    exit 1
  }
done

[[ "${CONFIG_COMMIT}" =~ ^[0-9a-f]{40}$ ]] || {
  printf 'error: CONFIG_COMMIT must be a full lowercase Git SHA\n' >&2
  exit 1
}
[[ "${PROFILE_ID}" =~ ^[a-z0-9][a-z0-9-]{0,31}$ ]] || {
  printf 'error: invalid PROFILE_ID: %s\n' "${PROFILE_ID}" >&2
  exit 1
}
[[ "${RELEASE}" =~ ^[0-9]+\.[0-9]+$ ]] || {
  printf 'error: RELEASE must use MAJOR.MINOR: %s\n' "${RELEASE}" >&2
  exit 1
}
# One authoring repository per game (their schemas differ); the allow-list is
# the trust boundary, and the game itself still comes from the profile.
config_repository="${CONFIG_REPOSITORY_URL}"
case "${config_repository}" in
  https://github.com/DrArzter/my-docker-minecraft-server-config | \
  https://github.com/DrArzter/my-docker-minecraft-server-config.git | \
  https://github.com/DrArzter/my-docker-factorio-server-config | \
  https://github.com/DrArzter/my-docker-factorio-server-config.git) ;;
  *)
    printf 'error: untrusted CONFIG_REPOSITORY_URL: %s\n' "${config_repository}" >&2
    exit 1
    ;;
esac

# docker is a minecraft-resolver dependency, checked by the resolver itself.
for command in aws git jq realpath; do
  command -v "${command}" >/dev/null 2>&1 || {
    printf 'error: required command not found: %s\n' "${command}" >&2
    exit 1
  }
done

workspace="$(mktemp -d /tmp/spawnpoint-aws-release.XXXXXXXX)"
cleanup() {
  rm -rf -- "${workspace}"
}
trap cleanup EXIT

config_checkout="${workspace}/config"
git init --quiet "${config_checkout}"
git -C "${config_checkout}" remote add origin "${config_repository}"
git -C "${config_checkout}" fetch --quiet --depth=1 origin "${CONFIG_COMMIT}"
git -C "${config_checkout}" checkout --quiet --detach FETCH_HEAD
[[ "$(git -C "${config_checkout}" rev-parse HEAD)" == "${CONFIG_COMMIT}" ]] || {
  printf 'error: fetched config commit does not match CONFIG_COMMIT\n' >&2
  exit 1
}

profile_directory="${config_checkout}/profiles/${PROFILE_ID}"
[[ -d "${profile_directory}" && ! -L "${profile_directory}" ]] || {
  printf 'error: profile does not exist at commit %s: %s\n' "${CONFIG_COMMIT}" "${PROFILE_ID}" >&2
  exit 1
}

game="$(jq -r '.game // "minecraft"' "${profile_directory}/profile.json")"
if [[ "${game}" == "minecraft" ]]; then
  [[ -n "${CF_API_KEY:-}" && "${CF_API_KEY}" != "REQUIRED_BY_CALLER" ]] || {
    printf 'error: CF_API_KEY is required for a minecraft profile\n' >&2
    exit 1
  }
fi

payload="${workspace}/payload"
"${server_scripts}/resolve-profile-mods.sh" "${profile_directory}" "${payload}/mods"

RELEASE_CREATED_BY="${RELEASE_CREATED_BY:-github-actions}" \
RELEASE_CHANGELOG="${RELEASE_CHANGELOG:-Profile ${PROFILE_ID} at ${CONFIG_COMMIT}}" \
  "${server_scripts}/build-profile-release.sh" \
    "${profile_directory}" "${RELEASE}" "${payload}/mods" "${payload}/manifest.json"

RELEASE_SOURCE_DIR="${payload}" \
  "${server_scripts}/upload-release.sh" "${payload}/manifest.json"

printf 'result=release_ready\n'
printf 'profile_id=%s\n' "${PROFILE_ID}"
printf 'game=%s\n' "${game}"
printf 'config_commit=%s\n' "${CONFIG_COMMIT}"
printf 'release=%s\n' "${RELEASE}"
printf 'manifest_key=releases/%s/manifest.json\n' "${RELEASE}"
