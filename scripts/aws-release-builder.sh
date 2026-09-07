#!/usr/bin/env bash

# CodeBuild entrypoint for producing an immutable release candidate. The
# buildspec embeds this repository's reviewed helper scripts at Terraform apply
# time; the only Git checkout performed here is the profile repository, which
# is treated strictly as data and never executed.

set -Eeuo pipefail

repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
server_scripts="${repository_root}/server/scripts"
# shellcheck source=scripts/_config-source.sh
source "${repository_root}/scripts/_config-source.sh"

if [[ "${BUILDER_MODE:-release}" == "preset-catalog" ]]; then
  exec "${repository_root}/scripts/aws-preset-catalog-builder.sh"
fi

# No default authoring repository: with one repository per game, a default is a
# silent choice of game, and the profile it resolves might even exist in the
# other repository. CF_API_KEY is checked later instead, after the profile is
# read: it is a minecraft-only requirement, and the game is a property of the
# profile (ADR-0034).
for variable in CONFIG_COMMIT CONFIG_SOURCE_KEY CONFIG_SOURCE_SHA256 PROFILE_ID RELEASE RELEASE_BUCKET CONFIG_REPOSITORY_URL; do
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
  https://github.com/DrArzter/my-docker-factorio-server-config.git | \
  https://github.com/DrArzter/my-docker-zomboid-server-config | \
  https://github.com/DrArzter/my-docker-zomboid-server-config.git) ;;
  *)
    printf 'error: untrusted CONFIG_REPOSITORY_URL: %s\n' "${config_repository}" >&2
    exit 1
    ;;
esac

# docker is a minecraft-resolver dependency, checked by the resolver itself.
for command in awk aws find git grep jq realpath sha256sum sort tar; do
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

materialize_config_source "${workspace}"
config_checkout="${CONFIG_CHECKOUT}"
# Existing profile resolvers require a clean checkout before reading relative
# inputs. Reconstruct one around the already hash-verified inert snapshot; the
# release manifest still records CONFIG_COMMIT rather than this synthetic SHA.
git -C "${config_checkout}" init --quiet
git -C "${config_checkout}" remote add origin "${config_repository}"
git -C "${config_checkout}" add profiles
git -C "${config_checkout}" -c user.name=Spawnpoint -c user.email=spawnpoint@invalid \
  commit --quiet -m "Verified config snapshot ${CONFIG_COMMIT}"

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
PROFILE_SOURCE_REPOSITORY="${config_repository}" \
PROFILE_SOURCE_COMMIT="${CONFIG_COMMIT}" \
  "${server_scripts}/build-profile-release.sh" \
    "${profile_directory}" "${RELEASE}" "${payload}/mods" "${payload}/manifest.json"

RELEASE_SOURCE_DIR="${payload}" \
  "${server_scripts}/upload-release.sh" "${payload}/manifest.json"

# A release and preset discovery are separate records, joined by the digest of
# the profile directory rather than by the repository-wide commit. This keeps
# an older build from marking a newer preset ready, while an unrelated edit in
# the same repository does not invalidate the profile that was actually built.
profile_digest="$({
  while IFS= read -r -d '' file; do
    relative="${file#"${profile_directory}/"}"
    printf '%s  %s\n' "$(sha256sum -- "${file}" | awk '{print $1}')" "${relative}"
  done < <(find "${profile_directory}" -type f -print0 | sort -z)
} | sha256sum | awk '{print $1}')"
catalog_key="presets/${game}/catalog.json"
catalog="${workspace}/preset-catalog.json"
if aws s3api get-object --bucket "${RELEASE_BUCKET}" --key "${catalog_key}" "${catalog}" >/dev/null 2>&1; then
  if jq -e \
    --arg id "${PROFILE_ID}" \
    --arg digest "${profile_digest}" \
    '.schema_version == 1 and any(.presets[]?; .id == $id and .profile_digest == $digest)' \
    "${catalog}" >/dev/null; then
    jq \
      --arg id "${PROFILE_ID}" \
      --arg digest "${profile_digest}" \
      --arg release "${RELEASE}" '
      .presets |= map(
        if .id == $id and .profile_digest == $digest
        then .build_status = "ready" | .latest_release = $release
        else . end
      )
    ' "${catalog}" >"${catalog}.updated"
    aws s3api put-object \
      --bucket "${RELEASE_BUCKET}" \
      --key "${catalog_key}" \
      --body "${catalog}.updated" \
      --server-side-encryption AES256 \
      --content-type application/json \
      >/dev/null
    printf 'preset_catalog=updated\n'
  else
    printf 'preset_catalog=stale\n'
  fi
else
  printf 'preset_catalog=missing\n'
fi

printf 'result=release_ready\n'
printf 'profile_id=%s\n' "${PROFILE_ID}"
printf 'game=%s\n' "${game}"
printf 'config_commit=%s\n' "${CONFIG_COMMIT}"
printf 'release=%s\n' "${RELEASE}"
printf 'manifest_key=releases/%s/manifest.json\n' "${RELEASE}"
