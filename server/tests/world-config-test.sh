#!/usr/bin/env bash

# A world's own config files (ADR-0093): written over the release's files,
# each checked against its digest, never outside the game's config roots.

set -Eeuo pipefail

REPOSITORY_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="${REPOSITORY_ROOT}/server/scripts/apply-world-config.sh"
fixture="$(mktemp -d)"
trap 'rm -rf -- "${fixture}"' EXIT

mkdir -p -- "${fixture}/bin" "${fixture}/data/config"
ln -s -- "${REPOSITORY_ROOT}/server/tests/fake-aws" "${fixture}/bin/aws"
export PATH="${fixture}/bin:${PATH}"
export FAKE_S3_ROOT="${fixture}/fake-s3"
export RELEASE_BUCKET="spawnpoint-test-releases"

put_world_file() {
  local text="$1" digest
  digest="$(printf '%s' "${text}" | sha256sum | awk '{print $1}')"
  mkdir -p -- "${FAKE_S3_ROOT}/${RELEASE_BUCKET}/worlds/world-a/config"
  printf '%s' "${text}" >"${FAKE_S3_ROOT}/${RELEASE_BUCKET}/worlds/world-a/config/${digest}"
  printf '%s' "${digest}"
}

expect_failure() {
  local name="$1"
  shift
  if "$@" >/dev/null 2>&1; then
    printf 'FAIL: %s succeeded\n' "${name}" >&2
    exit 1
  fi
}

# The release's file is there; the world's version replaces it, and a new file is added.
printf 'max_claims = 10\n' >"${fixture}/data/config/claims.toml"
edited="$(put_world_file $'max_claims = 50\n')"
added="$(put_world_file 'onEvent("x", () => {})')"
files="$(jq -cn --arg edited "${edited}" --arg added "${added}" '{"config/claims.toml": $edited, "kubejs/server_scripts/new.js": $added}')"
output="$("${SCRIPT}" "${fixture}/data" minecraft world-a "${files}")"
grep -qx 'result=applied' <<<"${output}"
grep -qx 'config_files=2' <<<"${output}"
[[ "$(cat "${fixture}/data/config/claims.toml")" == "max_claims = 50" ]]
[[ -f "${fixture}/data/kubejs/server_scripts/new.js" ]]

# No files: nothing to do.
grep -qx 'result=none' <<<"$("${SCRIPT}" "${fixture}/data" minecraft world-a '{}')"

# A path outside the roots, a digest that does not match, a link on the way, and a game with no roots.
expect_failure "a path outside the config roots" "${SCRIPT}" "${fixture}/data" minecraft world-a "$(jq -cn --arg d "${edited}" '{"ops.json": $d}')"
expect_failure "a parent segment" "${SCRIPT}" "${fixture}/data" minecraft world-a "$(jq -cn --arg d "${edited}" '{"config/../ops.json": $d}')"
wrong="$(printf 'x' | sha256sum | awk '{print $1}')"
cp -- "${FAKE_S3_ROOT}/${RELEASE_BUCKET}/worlds/world-a/config/${edited}" "${FAKE_S3_ROOT}/${RELEASE_BUCKET}/worlds/world-a/config/${wrong}"
expect_failure "a file that does not match its digest" "${SCRIPT}" "${fixture}/data" minecraft world-a "$(jq -cn --arg d "${wrong}" '{"config/claims.toml": $d}')"
mkdir -p -- "${fixture}/elsewhere"
ln -s -- "${fixture}/elsewhere" "${fixture}/data/defaultconfigs"
expect_failure "a link on the way" "${SCRIPT}" "${fixture}/data" minecraft world-a "$(jq -cn --arg d "${edited}" '{"defaultconfigs/a.toml": $d}')"
[[ -z "$(ls -A "${fixture}/elsewhere")" ]]
expect_failure "a game that keeps no config files" "${SCRIPT}" "${fixture}/data" factorio world-a "$(jq -cn --arg d "${edited}" '{"config/a.toml": $d}')"

printf 'world-config-test: ok\n'
