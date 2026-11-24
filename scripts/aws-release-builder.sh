#!/usr/bin/env bash

# CodeBuild entrypoint for producing an immutable release candidate. The
# buildspec embeds this repository's reviewed helper scripts at Terraform apply
# time. A selected preset-source adapter materializes authoring input strictly
# as data; no source-supplied code is executed.

set -Eeuo pipefail

# shellcheck source=../server/games/_legacy-game.sh
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/../server/games/_legacy-game.sh"

repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
server_scripts="${repository_root}/server/scripts"
# shellcheck source=scripts/_config-source.sh
source "${repository_root}/scripts/_config-source.sh"
# shellcheck source=scripts/_release-holders.sh
source "${repository_root}/scripts/_release-holders.sh"

if [[ "${BUILDER_MODE:-release}" == "preset-catalog" ]]; then
  exec "${repository_root}/scripts/aws-preset-catalog-builder.sh"
fi

# No default authoring repository: with one repository per game, a default is a
# silent choice of game, and the profile it resolves might even exist in the
# other repository. CF_API_KEY is checked later instead, after the profile is
# read: it is a minecraft-only requirement, and the game is a property of the
# profile (ADR-0034).
for variable in PROFILE_ID RELEASE RELEASE_BUCKET; do
  [[ -n "${!variable:-}" && "${!variable}" != "REQUIRED_BY_CALLER" ]] || {
    printf 'error: %s is required\n' "${variable}" >&2
    exit 1
  }
done

[[ "${PROFILE_ID}" =~ ^[a-z0-9][a-z0-9-]{0,31}$ ]] || {
  printf 'error: invalid PROFILE_ID: %s\n' "${PROFILE_ID}" >&2
  exit 1
}
[[ "${RELEASE}" =~ ^[0-9]+\.[0-9]+$ ]] || {
  printf 'error: RELEASE must use MAJOR.MINOR: %s\n' "${RELEASE}" >&2
  exit 1
}
# docker is a minecraft-resolver dependency, checked by the resolver itself.
for command in awk aws find git grep jq realpath sha256sum sort tar unzip; do
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
config_origin="${CONFIG_SOURCE_ORIGIN}"
config_revision="${CONFIG_SOURCE_REVISION}"
# Existing profile resolvers require a clean checkout before reading relative
# inputs. Reconstruct one around the already hash-verified inert snapshot; the
# release manifest records the adapter's verified revision rather than this
# synthetic Git SHA.
git -C "${config_checkout}" init --quiet
git -C "${config_checkout}" remote add origin "${config_origin}"
git -C "${config_checkout}" add profiles
git -C "${config_checkout}" -c user.name=Spawnpoint -c user.email=spawnpoint@invalid \
  commit --quiet -m "Verified config snapshot ${config_revision}"

profile_directory="${config_checkout}/profiles/${PROFILE_ID}"
[[ -d "${profile_directory}" && ! -L "${profile_directory}" ]] || {
  printf 'error: profile does not exist at revision %s: %s\n' "${config_revision}" "${PROFILE_ID}" >&2
  exit 1
}

game="$(jq -r --arg legacy_game "${LEGACY_GAME_ID}" '.game // $legacy_game' "${profile_directory}/profile.json")"
if [[ "${game}" == "minecraft" ]]; then
  [[ -n "${CF_API_KEY:-}" && "${CF_API_KEY}" != "REQUIRED_BY_CALLER" ]] || {
    printf 'error: CF_API_KEY is required for a minecraft profile\n' >&2
    exit 1
  }
fi

# How long a builder step took, for the build log. stderr keeps the result
# lines on stdout parseable; the first call counts from the script's start.
step_timing() {
  local now="${SECONDS}"
  printf 'timing step=%s seconds=%s\n' "$1" "$(( now - ${STEP_TIMING_MARK:-0} ))" >&2
  STEP_TIMING_MARK="${now}"
}
step_timing config_snapshot

payload="${workspace}/payload"
# Verified upstream files are kept under upstream/ in the release bucket, so a
# rebuild of the same pins reads them from S3 instead of CurseForge. A hit is
# also noted, so the objects-v1 writer can copy those bytes inside S3.
export UPSTREAM_CACHE_HITS_FILE="${workspace}/upstream-hits.tsv"
UPSTREAM_CACHE_BUCKET="${RELEASE_BUCKET}" \
  "${server_scripts}/resolve-profile-mods.sh" "${profile_directory}" "${payload}/mods"
step_timing resolve_mods

RELEASE_CREATED_BY="${RELEASE_CREATED_BY:-github-actions}" \
RELEASE_CHANGELOG="${RELEASE_CHANGELOG:-Profile ${PROFILE_ID} at ${config_revision}}" \
PROFILE_SOURCE_REPOSITORY="${config_origin}" \
PROFILE_SOURCE_COMMIT="${config_revision}" \
  "${server_scripts}/build-profile-release.sh" \
    "${profile_directory}" "${RELEASE}" "${payload}/mods" "${payload}/manifest.json"
step_timing build_release

# The plan: what this release changes compared with the preset's latest
# release, or PREVIOUS_RELEASE (`none` for a first release). It is descriptive,
# so any failure here only leaves the release without a plan.
plan_file=""
previous_release="${PREVIOUS_RELEASE:-}"
if [[ -z "${previous_release}" ]]; then
  previous_release=none
  if aws s3api get-object --bucket "${RELEASE_BUCKET}" --key "presets/${game}/catalog.json" \
    "${workspace}/plan-catalog.json" >/dev/null 2>&1; then
    previous_release="$(jq -r --arg id "${PROFILE_ID}" \
      'first(.presets[]? | select(.id == $id) | .latest_release // empty) // "none"' \
      "${workspace}/plan-catalog.json" 2>/dev/null)" || previous_release=none
  else
    printf 'plan_catalog=unreadable\n'
  fi
fi
previous_manifest=""
if [[ "${previous_release}" == none ]]; then
  previous_manifest=none
elif [[ ! "${previous_release}" =~ ^[0-9]+\.[0-9]+$ ]]; then
  printf 'plan=skipped\nplan_reason=invalid_previous_release\n'
elif [[ "${previous_release}" == "${RELEASE}" ]]; then
  printf 'plan=skipped\nplan_reason=same_release\n'
elif aws s3api get-object --bucket "${RELEASE_BUCKET}" \
  --key "releases/${game}/${PROFILE_ID}/${previous_release}/manifest.json" \
  "${workspace}/previous-manifest.json" >/dev/null 2>&1; then
  previous_manifest="${workspace}/previous-manifest.json"
else
  printf 'plan=skipped\nplan_reason=previous_manifest_unreadable\nplan_previous_release=%s\n' "${previous_release}"
fi
if [[ -n "${previous_manifest}" ]]; then
  if RELEASE_PLAN_OUTPUT="${workspace}/plan.json" \
    "${server_scripts}/plan-release.sh" "${payload}/manifest.json" "${previous_manifest}"; then
    plan_file="${workspace}/plan.json"
  else
    printf 'plan=failed\n'
  fi
fi

step_timing plan

# The digest names the profile that built the release; the reference table
# keeps it on the release item (objects-v1 only).
profile_digest="$({
  while IFS= read -r -d '' file; do
    relative="${file#"${profile_directory}/"}"
    printf '%s  %s\n' "$(sha256sum -- "${file}" | awk '{print $1}')" "${relative}"
  done < <(find "${profile_directory}" -type f -print0 | sort -z)
} | sha256sum | awk '{print $1}')"

# One build id for the table's build holder; a local run gets a fresh one.
build_id="${CODEBUILD_BUILD_ID:-}"
[[ -n "${build_id}" ]] || build_id="local-$(cat /proc/sys/kernel/random/uuid 2>/dev/null || date +%s)-$$"
upstream_map=""
if [[ -s "${UPSTREAM_CACHE_HITS_FILE}" ]]; then
  upstream_map="${workspace}/upstream-map.json"
  jq -Rn '[inputs | split("\t") | select(length == 2) | {key: .[0], value: .[1]}] | from_entries' \
    "${UPSTREAM_CACHE_HITS_FILE}" >"${upstream_map}"
fi

RELEASE_PLAN="${plan_file}" \
RELEASE_SOURCE_DIR="${payload}" \
RELEASE_BUILD_ID="${build_id}" \
RELEASE_REFS_TABLE="${RELEASE_REFS_TABLE:-spawnpoint-release-refs}" \
RELEASE_PROFILE_DIGEST="${profile_digest}" \
RELEASE_UPSTREAM_MAP="${upstream_map}" \
  "${server_scripts}/upload-release.sh" "${payload}/manifest.json"
step_timing upload

# A release and preset discovery are separate records, joined by the digest of
# the profile directory (computed before the upload) rather than by the
# repository-wide commit. This keeps an older build from marking a newer preset
# ready, while an unrelated edit in the same repository does not invalidate the
# profile that was actually built.
catalog_key="presets/${game}/catalog.json"
catalog="${workspace}/preset-catalog.json"
if aws s3api get-object --bucket "${RELEASE_BUCKET}" --key "${catalog_key}" "${catalog}" >/dev/null 2>&1; then
  if jq -e \
    --arg id "${PROFILE_ID}" \
    --arg digest "${profile_digest}" \
    '(.schema_version == 1 or .schema_version == 2) and any(.presets[]?; .id == $id and .profile_digest == $digest)' \
    "${catalog}" >/dev/null; then
    # The history is kept: earlier releases stay, and the new one records the
    # revision it was built from (ADR-0042). Only a published release is listed.
    jq \
      --arg id "${PROFILE_ID}" \
      --arg digest "${profile_digest}" \
      --arg commit "${config_revision}" \
      --arg release "${RELEASE}" '
      .presets |= map(
        if .id == $id and .profile_digest == $digest
        then .build_status = "ready" |
          .built_from = ((.built_from // {}) + {($release): {profile_digest: $digest, source_commit: (.source_commit // $commit)}}) |
          .releases = (reduce (((.releases // []) + [$release])[]) as $version ([]; if index($version) == null then . + [$version] else . end)) |
          .latest_release = $release
        else . end
      ) | .schema_version = 2
    ' "${catalog}" >"${catalog}.updated"
    # Holder first (ADR-0080): the catalog may list a release only after the
    # table says that the catalog holds it. A failure stops before the write.
    hold_catalog_releases "${catalog}.updated" "${game}"
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

step_timing catalog
printf 'result=release_ready\n'
printf 'profile_id=%s\n' "${PROFILE_ID}"
printf 'game=%s\n' "${game}"
printf 'source_kind=%s\n' "${CONFIG_SOURCE_KIND}"
printf 'source_revision=%s\n' "${config_revision}"
printf 'config_commit=%s\n' "${config_revision}"
printf 'release=%s\n' "${RELEASE}"
printf 'manifest_key=releases/%s/%s/%s/manifest.json\n' "${game}" "${PROFILE_ID}" "${RELEASE}"
