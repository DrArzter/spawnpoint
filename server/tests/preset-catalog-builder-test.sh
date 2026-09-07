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
jq -n '{schema_version: 1, game: "factorio", id: "space-age", display_name: "Factorio Space Age"}' >"${config}/profiles/space-age/profile.json"
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
catalog="${FAKE_S3_ROOT}/spawnpoint-test-releases/presets/factorio/catalog.json"
jq -e --arg commit "${commit}" '
  .schema_version == 1 and .game == "factorio" and .source.commit == $commit
  and ([.presets[].id] | sort) == ["factorio-vanilla", "space-age"]
  and all(.presets[]; .build_status == "unbuilt" and .latest_release == null and (.profile_digest | length == 64))
' "${catalog}" >/dev/null

jq '(.presets[] | select(.id == "factorio-vanilla")) |= (.build_status = "ready" | .latest_release = "1.0")' \
  "${catalog}" >"${catalog}.updated"
mv -- "${catalog}.updated" "${catalog}"
run_builder >/dev/null
jq -e '
  (.presets[] | select(.id == "factorio-vanilla") | .build_status == "ready" and .latest_release == "1.0")
  and (.presets[] | select(.id == "space-age") | .build_status == "unbuilt")
' "${catalog}" >/dev/null

printf 'result=passed\n'
