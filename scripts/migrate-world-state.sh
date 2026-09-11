#!/usr/bin/env bash

# Adopt one legacy world-scoped release pointer into the world + wipe model.
# Dry-run is the default. --apply creates only missing, byte-validated objects;
# retries resume a matching partial write and refuse every conflicting object.

set -Eeuo pipefail

REPOSITORY_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
catalog="${SPAWNPOINT_WORLD_CATALOG:-${REPOSITORY_ROOT}/server/worlds/catalog.json}"
profile="${AWS_PROFILE:-spawnpoint}"
region="${AWS_REGION:-eu-central-1}"

usage() {
  printf 'usage: %s <world-id> [preset-id] [--apply]\n' "$0" >&2
}

world_id="${1:-}"
preset_id="${2:-}"
apply=false
if [[ "${2:-}" == "--apply" ]]; then
  preset_id=""
  apply=true
elif [[ "${3:-}" == "--apply" ]]; then
  apply=true
elif [[ $# -gt 2 ]]; then
  usage
  exit 2
fi
[[ "${world_id}" =~ ^[a-z0-9][a-z0-9-]{0,31}$ ]] || { usage; exit 2; }

for command in aws jq sha256sum; do
  command -v "${command}" >/dev/null 2>&1 || { printf 'error: required command not found: %s\n' "${command}" >&2; exit 1; }
done
[[ -f "${catalog}" ]] || { printf 'error: world catalog not found: %s\n' "${catalog}" >&2; exit 1; }

entry="$(jq -ce --arg id "${world_id}" '.worlds[] | select(.id == $id)' "${catalog}")" || {
  printf 'error: legacy world is not in the host catalog: %s\n' "${world_id}" >&2
  exit 1
}
game="$(jq -r '.game // "minecraft"' <<<"${entry}")"
display_name="$(jq -r '.display_name' <<<"${entry}")"
preset_id="${preset_id:-$(jq -r '.profile_id' <<<"${entry}")}"
[[ "${game}" =~ ^[a-z0-9][a-z0-9-]{0,31}$ && "${preset_id}" =~ ^[a-z0-9][a-z0-9-]{0,31}$ ]] || {
  printf 'error: invalid game or preset identity in catalog\n' >&2
  exit 1
}
[[ "$(jq -r '.connectivity // "zerotier"' <<<"${entry}")" == "zerotier" ]] || {
  printf 'error: generation-managed worlds currently require zerotier connectivity\n' >&2
  exit 1
}

if [[ -z "${RELEASE_BUCKET:-}" ]]; then
  account_id="$(aws sts get-caller-identity --profile "${profile}" --query Account --output text)"
  [[ "${account_id}" =~ ^[0-9]{12}$ ]] || { printf 'error: could not resolve AWS account id\n' >&2; exit 1; }
  RELEASE_BUCKET="spawnpoint-releases-${account_id}"
fi

workspace="$(mktemp -d /tmp/spawnpoint-world-state-migration.XXXXXXXX)"
cleanup() { rm -rf -- "${workspace}"; }
trap cleanup EXIT

get_object() {
  aws --profile "${profile}" --region "${region}" --no-cli-pager s3api get-object \
    --bucket "${RELEASE_BUCKET}" --key "$1" "$2" >/dev/null 2>&1
}

legacy_key="worlds/${world_id}/release.json"
legacy="${workspace}/legacy.json"
get_object "${legacy_key}" "${legacy}" || {
  printf 'error: legacy release pointer not found: s3://%s/%s\n' "${RELEASE_BUCKET}" "${legacy_key}" >&2
  exit 1
}
jq -e --arg world "${world_id}" '
  .schema_version == 1 and .world == $world and
  (.desired_release | type == "string" and test("^[0-9]+\\.[0-9]+$")) and
  ((.active_release == null) or (.active_release | type == "string" and test("^[0-9]+\\.[0-9]+$")))
' "${legacy}" >/dev/null || { printf 'error: invalid legacy release pointer\n' >&2; exit 1; }

preset_catalog="${workspace}/presets.json"
get_object "presets/${game}/catalog.json" "${preset_catalog}" || {
  printf 'error: preset catalog not found for game: %s\n' "${game}" >&2
  exit 1
}
preset="$(jq -ce --arg game "${game}" --arg preset "${preset_id}" \
  --arg release "$(jq -r '.desired_release' "${legacy}")" '
  select(.schema_version == 2 and .game == $game) |
  .source as $source |
  .presets[] | select(.id == $preset) |
  select(.build_status == "ready" and (.releases | index($release) != null)) |
  . + {repository: $source.repository, commit: $source.commit}
' "${preset_catalog}")" || {
  printf 'error: ready preset not found: %s/%s\n' "${game}" "${preset_id}" >&2
  exit 1
}
jq -e '
  (.repository | type == "string" and startswith("https://github.com/")) and
  (.commit | type == "string" and test("^[0-9a-f]{40}$")) and
  (.profile_digest | type == "string" and test("^[0-9a-f]{64}$"))
' <<<"${preset}" >/dev/null || { printf 'error: invalid preset provenance\n' >&2; exit 1; }

release="$(jq -r '.desired_release' "${legacy}")"
created_at="$(jq -r '.updated_at // empty' "${legacy}")"
[[ "${created_at}" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T ]] || created_at="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
legacy_digest="$(sha256sum "${legacy}" | awk '{print $1}')"
generation_hash="$(printf 'spawnpoint-world-migration:%s:%s' "${world_id}" "${legacy_digest}" | sha256sum | awk '{print substr($1, 1, 32)}')"
generation_id="gen-${generation_hash}"

state="${workspace}/release-state.json"
record="${workspace}/world.json"
jq -n --arg world "${world_id}" --arg generation "${generation_id}" --arg release "${release}" \
  --argjson active "$(jq '.active_release' "${legacy}")" --arg at "${created_at}" '
  {schema_version: 2, world_id: $world, generation_id: $generation, desired_release: $release,
   active_release: $active, updated_at: $at, updated_by: "world-state-migration", source: "migration"}
' >"${state}"
jq -n --arg world "${world_id}" --arg game "${game}" --arg display "${display_name}" \
  --arg preset_id "${preset_id}" --arg repository "$(jq -r '.repository' <<<"${preset}")" \
  --arg commit "$(jq -r '.commit' <<<"${preset}")" --arg digest "$(jq -r '.profile_digest' <<<"${preset}")" \
  --arg generation "${generation_id}" --arg release "${release}" --arg at "${created_at}" '
  {schema_version: 1, world_id: $world, game: $game, display_name: $display, status: "active",
   connectivity: "zerotier", storage_layout: "generation",
   preset: {id: $preset_id, repository: $repository, commit: $commit, profile_digest: $digest},
   current_generation: {id: $generation, release: $release, created_at: $at, source: {kind: "preset"}},
   previous_generations: []}
' >"${record}"

state_key="worlds/${world_id}/generations/${generation_id}/release.json"
record_key="worlds/${world_id}/world.json"
printf 'result=%s\n' "$(${apply} && printf ready_to_apply || printf dry_run)"
printf 'world_id=%s\n' "${world_id}"
printf 'preset_id=%s\n' "${preset_id}"
printf 'generation_id=%s\n' "${generation_id}"
printf 'release=%s\n' "${release}"
printf 'state_key=%s\n' "${state_key}"
printf 'record_key=%s\n' "${record_key}"
${apply} || exit 0

put_if_missing() {
  local key="$1" expected="$2" observed="${workspace}/observed.json"
  if get_object "${key}" "${observed}"; then
    jq -e --slurpfile expected "${expected}" '. == $expected[0]' "${observed}" >/dev/null || {
      printf 'error: conflicting migration object: s3://%s/%s\n' "${RELEASE_BUCKET}" "${key}" >&2
      exit 1
    }
    return
  fi
  aws --profile "${profile}" --region "${region}" --no-cli-pager s3api put-object \
    --bucket "${RELEASE_BUCKET}" --key "${key}" --body "${expected}" \
    --if-none-match '*' --server-side-encryption AES256 --content-type application/json >/dev/null
}

# The world descriptor is the discoverability commit. A retry can safely
# resume after a release-state-only partial write.
put_if_missing "${state_key}" "${state}"
put_if_missing "${record_key}" "${record}"
printf 'result=migrated\n'
