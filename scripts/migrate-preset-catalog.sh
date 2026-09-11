#!/usr/bin/env bash

# Upgrade one production preset catalog from schema v1 to schema v2. Release
# history is recovered from latest_release and every provenance-bearing legacy
# manifest that belongs to a preset in this game.
# A conditional write prevents this one-time migration from overwriting a
# concurrent catalog build.

set -Eeuo pipefail

profile="${AWS_PROFILE:-spawnpoint}"
region="${AWS_REGION:-eu-central-1}"
apply=false

usage() {
  printf 'usage: %s <game> [--apply]\n' "$0" >&2
}

[[ $# -eq 1 || ( $# -eq 2 && "$2" == "--apply" ) ]] || { usage; exit 2; }
game="$1"
[[ $# -eq 1 ]] || apply=true
[[ "${game}" =~ ^[a-z0-9][a-z0-9-]{0,31}$ ]] || { usage; exit 2; }
for command in aws cmp jq; do
  command -v "${command}" >/dev/null 2>&1 || { printf 'error: required command not found: %s\n' "${command}" >&2; exit 1; }
done

if [[ -z "${RELEASE_BUCKET:-}" ]]; then
  account_id="$(aws sts get-caller-identity --profile "${profile}" --region "${region}" --query Account --output text)"
  [[ "${account_id}" =~ ^[0-9]{12}$ ]] || { printf 'error: could not resolve AWS account id\n' >&2; exit 1; }
  RELEASE_BUCKET="spawnpoint-releases-${account_id}"
fi

workspace="$(mktemp -d /tmp/spawnpoint-preset-catalog-migration.XXXXXXXX)"
cleanup() { rm -rf -- "${workspace}"; }
trap cleanup EXIT
catalog_key="presets/${game}/catalog.json"
source_catalog="${workspace}/catalog-v1.json"
target_catalog="${workspace}/catalog-v2.json"
discovered_releases="${workspace}/discovered-releases.jsonl"
: >"${discovered_releases}"

etag="$(aws s3api head-object --profile "${profile}" --region "${region}" \
  --bucket "${RELEASE_BUCKET}" --key "${catalog_key}" --query ETag --output text)"
aws s3api get-object --profile "${profile}" --region "${region}" \
  --bucket "${RELEASE_BUCKET}" --key "${catalog_key}" "${source_catalog}" >/dev/null

# Recover every release identity that the v1 catalog could not retain. Only
# legacy one-segment prefixes are considered; canonical objects are ignored.
mapfile -t manifest_keys < <(
  aws s3api list-objects-v2 --profile "${profile}" --region "${region}" \
    --bucket "${RELEASE_BUCKET}" --prefix "releases/" \
    --query 'Contents[?ends_with(Key, `/manifest.json`)].Key' --output text | tr '\t' '\n' | sed '/^$/d;/^None$/d' | sort
)
for manifest_key in "${manifest_keys[@]}"; do
  [[ "${manifest_key}" =~ ^releases/([^/]+)/manifest\.json$ ]] || continue
  release="${BASH_REMATCH[1]}"
  legacy_manifest="${workspace}/legacy-${release}.json"
  aws s3api get-object --profile "${profile}" --region "${region}" \
    --bucket "${RELEASE_BUCKET}" --key "${manifest_key}" "${legacy_manifest}" >/dev/null
  jq -e --arg game "${game}" '(.game // "minecraft") == $game and (.source_profile.id | type == "string")' \
    "${legacy_manifest}" >/dev/null || continue
  jq -cn --arg id "$(jq -r '.source_profile.id' "${legacy_manifest}")" --arg release "${release}" \
    '{id: $id, release: $release}' >>"${discovered_releases}"
done

jq -e --arg game "${game}" '
  (.schema_version == 1 or .schema_version == 2)
  and .game == $game
  and (.source.repository | type == "string")
  and (.source.commit | type == "string" and test("^[0-9a-f]{40}$"))
  and (.presets | type == "array")
  and all(.presets[];
    (.id | type == "string" and test("^[a-z0-9][a-z0-9-]{0,31}$"))
    and (.latest_release == null or (.latest_release | type == "string" and test("^[0-9]+\\.[0-9]+$")))
  )
' "${source_catalog}" >/dev/null || { printf 'error: invalid preset catalog: s3://%s/%s\n' "${RELEASE_BUCKET}" "${catalog_key}" >&2; exit 1; }

jq --slurpfile discovered "${discovered_releases}" '
  .schema_version = 2
  | .presets |= map(. as $preset |
      .releases = (
        ([$discovered[] | select(.id == $preset.id) | .release]
        + (if (.releases | type) == "array" then .releases else [] end)) as $known |
        (reduce ($known[]) as $version ([]; if index($version) == null then . + [$version] else . end)) |
        if $preset.latest_release == null then .
        else map(select(. != $preset.latest_release)) + [$preset.latest_release]
        end
      )
    )
' "${source_catalog}" >"${target_catalog}"

jq -e --arg game "${game}" '
  .schema_version == 2 and .game == $game
  and (.source.repository | type == "string" and startswith("https://github.com/"))
  and (.source.commit | type == "string" and test("^[0-9a-f]{40}$"))
  and (([.presets[].id] | unique | length) == (.presets | length))
  and all(.presets[]; . as $preset |
    (.id | type == "string" and test("^[a-z0-9][a-z0-9-]{0,31}$"))
    and (.display_name | type == "string" and length > 0 and length <= 80)
    and (.profile_digest | type == "string" and test("^[0-9a-f]{64}$"))
    and (.build_status == "unbuilt" or .build_status == "building" or .build_status == "ready" or .build_status == "failed")
    and (.releases | type == "array" and all(.[]; type == "string" and test("^[0-9]+\\.[0-9]+$")))
    and ((.releases | unique | length) == (.releases | length))
    and (.latest_release == null or (.releases | index($preset.latest_release) != null))
    and (.build_status != "ready" or .latest_release != null)
  )
' "${target_catalog}" >/dev/null || { printf 'error: migration would produce an invalid schema-v2 catalog\n' >&2; exit 1; }

normalized_source="${workspace}/catalog-source.normalized.json"
normalized_target="${workspace}/catalog-target.normalized.json"
jq -S . "${source_catalog}" >"${normalized_source}"
jq -S . "${target_catalog}" >"${normalized_target}"
if cmp -s -- "${normalized_source}" "${normalized_target}"; then
  printf 'result=already_current\n'
elif ! ${apply}; then
  printf 'result=dry_run\n'
else
  aws s3api put-object --profile "${profile}" --region "${region}" \
    --bucket "${RELEASE_BUCKET}" --key "${catalog_key}" --body "${target_catalog}" \
    --if-match "${etag}" --server-side-encryption AES256 --content-type application/json >/dev/null
  printf 'result=migrated\n'
fi
printf 'catalog_key=%s\n' "${catalog_key}"
printf 'presets=%s\n' "$(jq '.presets | length' "${target_catalog}")"
jq -r '.presets[] | "preset=\(.id) releases=\(.releases | join(","))"' "${target_catalog}"
