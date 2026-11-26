#!/usr/bin/env bash

set -Eeuo pipefail

repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
builder="${repository_root}/scripts/aws-preset-catalog-builder.sh"
fixture="$(mktemp -d /tmp/spawnpoint-preset-catalog-test.XXXXXXXX)"
cleanup() {
  rm -rf -- "${fixture}"
}
trap cleanup EXIT

config="${fixture}/config"
mkdir -p -- "${config}/profiles/factorio-vanilla" "${config}/profiles/space-age" "${fixture}/bin"
git -C "${config}" init --quiet
jq -n '{schema_version: 1, game: "factorio", id: "factorio-vanilla", display_name: "Factorio vanilla"}' >"${config}/profiles/factorio-vanilla/profile.json"
# Space Age names its own footprint (ADR-0054); vanilla takes the game's.
jq -n '{schema_version: 1, game: "factorio", id: "space-age", display_name: "Factorio Space Age", footprint: {memory_mib: 14336, cores: 2}}' >"${config}/profiles/space-age/profile.json"
git -C "${config}" add profiles
git -C "${config}" -c user.name=Test -c user.email=test@example.invalid commit --quiet -m profiles
commit="$(git -C "${config}" rev-parse HEAD)"

ln -s -- "${repository_root}/server/tests/fake-aws" "${fixture}/bin/aws"
export FAKE_S3_ROOT="${fixture}/s3"
url="https://github.com/DrArzter/my-docker-factorio-server-config.git"
source_key="config-sources/DrArzter/my-docker-factorio-server-config/${commit}.tar.gz"
source_archive="${fixture}/config-source.tar.gz"
git -C "${config}" archive --format=tar.gz --output="${source_archive}" "${commit}" profiles
source_sha256="$(sha256sum -- "${source_archive}" | awk '{print $1}')"
mkdir -p -- "${FAKE_S3_ROOT}/spawnpoint-test-releases/$(dirname -- "${source_key}")"
cp -- "${source_archive}" "${FAKE_S3_ROOT}/spawnpoint-test-releases/${source_key}"

run_builder() {
  env \
    PATH="${fixture}/bin:${PATH}" \
    CONFIG_REPOSITORY_URL="${url}" \
    CONFIG_COMMIT="${commit}" \
    CONFIG_SOURCE_KEY="${source_key}" \
    CONFIG_SOURCE_SHA256="${source_sha256}" \
    RELEASE_BUCKET=spawnpoint-test-releases \
    "${builder}"
}

if env \
  PATH="${fixture}/bin:${PATH}" \
  CONFIG_REPOSITORY_URL="${url}" \
  CONFIG_COMMIT="${commit}" \
  CONFIG_SOURCE_KEY="${source_key}" \
  CONFIG_SOURCE_SHA256=0000000000000000000000000000000000000000000000000000000000000000 \
  RELEASE_BUCKET=spawnpoint-test-releases \
  "${builder}" >/dev/null 2>&1; then
  printf 'expected failure: tampered config snapshot\n' >&2
  exit 1
fi

output="$(run_builder)"
grep -qx 'result=preset_catalog_ready' <<<"${output}"
grep -qx 'presets=2' <<<"${output}"
grep -qx 'source_kind=github-snapshot' <<<"${output}"
grep -qx "source_revision=${commit}" <<<"${output}"
catalog="${FAKE_S3_ROOT}/spawnpoint-test-releases/presets/factorio/catalog.json"
jq -e --arg commit "${commit}" '
  .schema_version == 2 and .game == "factorio"
  and .source.kind == "github-snapshot"
  and .source.origin == "https://github.com/DrArzter/my-docker-factorio-server-config"
  and .source.revision == $commit and .source.commit == $commit
  and ([.presets[].id] | sort) == ["factorio-vanilla", "space-age"]
  and all(.presets[]; .build_status == "unbuilt" and .releases == [] and .latest_release == null and (.profile_digest | length == 64))
' "${catalog}" >/dev/null
jq -e '
  (.presets[] | select(.id == "space-age") | .footprint == {memory_mib: 14336, cores: 2})
  and (.presets[] | select(.id == "factorio-vanilla") | has("footprint") | not)
' "${catalog}" >/dev/null

jq '(.presets[] | select(.id == "factorio-vanilla")) |= (.build_status = "ready" | .releases = ["1.0"] | .latest_release = "1.0")' \
  "${catalog}" >"${catalog}.updated"
mv -- "${catalog}.updated" "${catalog}"
run_builder >/dev/null
jq -e '
  (.presets[] | select(.id == "factorio-vanilla") | .build_status == "ready" and .releases == ["1.0"] and .latest_release == "1.0")
  and (.presets[] | select(.id == "space-age") | .build_status == "unbuilt")
' "${catalog}" >/dev/null

# An unrelated repository commit must not move an unchanged preset's Source.
original_commit="${commit}"
git -C "${config}" -c user.name=Test -c user.email=test@example.invalid commit --quiet --allow-empty -m unrelated
commit="$(git -C "${config}" rev-parse HEAD)"
source_key="config-sources/DrArzter/my-docker-factorio-server-config/${commit}.tar.gz"
git -C "${config}" archive --format=tar.gz --output="${source_archive}" "${commit}" profiles
source_sha256="$(sha256sum -- "${source_archive}" | awk '{print $1}')"
cp -- "${source_archive}" "${FAKE_S3_ROOT}/spawnpoint-test-releases/${source_key}"
run_builder >/dev/null
jq -e --arg original "${original_commit}" --arg current "${commit}" '
  .source.commit == $current and all(.presets[]; .source_commit == $original)
' "${catalog}" >/dev/null

# Full-history publishers can correct legacy catalog provenance independently
# of readiness. Each profile gets its own path-specific revision.
revisions="$(jq -cn --arg first "${original_commit}" --arg second "${commit}" '{"factorio-vanilla": $first, "space-age": $second}')"
git -C "${config}" archive --format=tar.gz --output="${source_archive}" \
  --add-virtual-file="profiles/.source-revisions.json:${revisions}" "${commit}" profiles
source_sha256="$(sha256sum -- "${source_archive}" | awk '{print $1}')"
cp -- "${source_archive}" "${FAKE_S3_ROOT}/spawnpoint-test-releases/${source_key}"
run_builder >/dev/null
jq -e --arg first "${original_commit}" --arg second "${commit}" '
  (.presets[] | select(.id == "factorio-vanilla") | .source_commit == $first and .build_status == "ready" and .latest_release == "1.0")
  and (.presets[] | select(.id == "space-age") | .source_commit == $second)
' "${catalog}" >/dev/null

git -C "${config}" archive --format=tar.gz --output="${source_archive}" \
  --add-virtual-file='profiles/.source-revisions.json:{"space-age":"main"}' "${commit}" profiles
source_sha256="$(sha256sum -- "${source_archive}" | awk '{print $1}')"
cp -- "${source_archive}" "${FAKE_S3_ROOT}/spawnpoint-test-releases/${source_key}"
if run_builder >/dev/null 2>&1; then
  printf 'expected failure: invalid profile revision\n' >&2
  exit 1
fi

git -C "${config}" archive --format=tar.gz --output="${source_archive}" \
  --add-virtual-file="profiles/.source-revisions.json:{\"space-age\":\"${commit}\"}" "${commit}" profiles
source_sha256="$(sha256sum -- "${source_archive}" | awk '{print $1}')"
cp -- "${source_archive}" "${FAKE_S3_ROOT}/spawnpoint-test-releases/${source_key}"
if run_builder >/dev/null 2>&1; then
  printf 'expected failure: missing profile revision\n' >&2
  exit 1
fi

# --- Release history across digests (ADR-0042) ---
publish_snapshot() {
  local message="$1"
  git -C "${config}" add profiles
  git -C "${config}" -c user.name=Test -c user.email=test@example.invalid commit --quiet --allow-empty -m "${message}"
  commit="$(git -C "${config}" rev-parse HEAD)"
  source_key="config-sources/DrArzter/my-docker-factorio-server-config/${commit}.tar.gz"
  git -C "${config}" archive --format=tar.gz --output="${source_archive}" "${commit}" profiles
  source_sha256="$(sha256sum -- "${source_archive}" | awk '{print $1}')"
  cp -- "${source_archive}" "${FAKE_S3_ROOT}/spawnpoint-test-releases/${source_key}"
}
preset_field() {
  local id="$1" path="$2"
  jq -r --arg id "${id}" ".presets[] | select(.id == \$id) | ${path}" "${catalog}"
}
releases_root="${FAKE_S3_ROOT}/spawnpoint-test-releases/releases/factorio/factorio-vanilla"
put_manifest() {
  local release="$1" created_at="${2:-2026-11-01T00:00:00Z}"
  mkdir -p -- "${releases_root}/${release}"
  jq -n --arg release "${release}" --arg commit "${commit}" --arg created_at "${created_at}" \
    '{game: "factorio", release: $release, created_at: $created_at, source_profile: {id: "factorio-vanilla", repository: "https://github.com/DrArzter/my-docker-factorio-server-config", commit: $commit}}' \
    >"${releases_root}/${release}/manifest.json"
}

# The ready release "1.0" was built from this digest and commit.
publish_snapshot "revision before the edit"
run_builder >/dev/null
old_digest="$(preset_field factorio-vanilla .profile_digest)"
old_commit="$(preset_field factorio-vanilla .source_commit)"
[[ "$(preset_field factorio-vanilla .build_status)" == ready ]]

# A digest change starts unbuilt but keeps every release, marked with the
# revision it was built from. latest_release stays the newest published one.
printf 'edited\n' >"${config}/profiles/factorio-vanilla/extra.txt"
publish_snapshot "edit the profile"
run_builder >/dev/null
jq -e --arg old_digest "${old_digest}" --arg old_commit "${old_commit}" '
  (.presets[] | select(.id == "factorio-vanilla")
    | .profile_digest != $old_digest and .build_status == "unbuilt"
      and .releases == ["1.0"] and .latest_release == "1.0"
      and .built_from == {"1.0": {profile_digest: $old_digest, source_commit: $old_commit}})
  and (.presets[] | select(.id == "space-age") | .build_status == "unbuilt" and .releases == [] and (has("built_from") | not))
' "${catalog}" >/dev/null

# A folder without a manifest is a failed build and is never listed. A
# published release that the catalog does not list is added, from an unknown
# revision, and does not take latest_release from a known one.
mkdir -p -- "${releases_root}/2.0/mods"
printf 'partial\n' >"${releases_root}/2.0/mods/example.zip"
put_manifest 1.5
run_builder >/dev/null
[[ "$(preset_field factorio-vanilla '.releases | join(",")')" == "1.0,1.5" ]]
[[ "$(preset_field factorio-vanilla .latest_release)" == "1.0" ]]
[[ "$(preset_field factorio-vanilla '.built_from["1.5"].profile_digest')" == null ]]
[[ "$(preset_field factorio-vanilla '.built_from["1.0"].profile_digest')" == "${old_digest}" ]]

# A catalog that forgot its history (the entry was reset on a digest change)
# gets it back from the manifests, so a world's release stays usable.
jq '(.presets[] | select(.id == "factorio-vanilla")) |= (.releases = [] | .latest_release = null | del(.built_from))' \
  "${catalog}" >"${catalog}.forgotten"
mv -- "${catalog}.forgotten" "${catalog}"
run_builder >/dev/null
jq -e '
  .presets[] | select(.id == "factorio-vanilla")
  | .build_status == "unbuilt" and .releases == ["1.5"] and .latest_release == "1.5"
    and .built_from["1.5"].profile_digest == null
' "${catalog}" >/dev/null

# releases stays oldest first, because promotion offers only the releases
# after a world's active one. A recovered release is older than the kept ones.
put_manifest 1.7 2026-11-02T00:00:00Z
jq '(.presets[] | select(.id == "factorio-vanilla")) |= (.releases = ["1.7"] | .latest_release = "1.7")' \
  "${catalog}" >"${catalog}.newer"
mv -- "${catalog}.newer" "${catalog}"
run_builder >/dev/null
[[ "$(preset_field factorio-vanilla '.releases | join(",")')" == "1.5,1.7" ]]
[[ "$(preset_field factorio-vanilla .latest_release)" == "1.7" ]]

# A list written newest first by an earlier recovery is put back in order.
jq '(.presets[] | select(.id == "factorio-vanilla")) |= (.releases = ["1.7", "1.5"])' \
  "${catalog}" >"${catalog}.reversed"
mv -- "${catalog}.reversed" "${catalog}"
run_builder >/dev/null
[[ "$(preset_field factorio-vanilla '.releases | join(",")')" == "1.5,1.7" ]]

# Without a listing the catalog still publishes and keeps what it has.
FAKE_S3_LIST_FAIL=true run_builder >/dev/null 2>&1
[[ "$(preset_field factorio-vanilla '.releases | join(",")')" == "1.5,1.7" ]]

printf 'result=passed\n'
