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

run_builder() {
  env \
    PATH="${fixture}/bin:${PATH}" \
    GIT_ALLOW_PROTOCOL=file \
    GIT_CONFIG_COUNT=1 \
    GIT_CONFIG_KEY_0="url.file://${config}.insteadOf" \
    GIT_CONFIG_VALUE_0="${url}" \
    CONFIG_REPOSITORY_URL="${url}" \
    CONFIG_COMMIT="${commit}" \
    RELEASE_BUCKET=spawnpoint-test-releases \
    "${builder}"
}

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
