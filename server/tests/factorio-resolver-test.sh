#!/usr/bin/env bash

# Distribution model B, offline: pins are real portal versions, downloads need
# the token, the cache heals, and mod-list.json is generated from the
# directory rather than carried in payloads.

set -Eeuo pipefail

REPOSITORY_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
GAMES="${REPOSITORY_ROOT}/server/games"
fixture="$(mktemp -d /tmp/spawnpoint-factorio-resolver-test.XXXXXXXX)"
cleanup() {
  rm -rf -- "${fixture}"
}
trap cleanup EXIT

expect_failure() {
  local label="$1"
  shift
  if "$@" >/dev/null 2>&1; then
    printf 'expected failure: %s\n' "${label}" >&2
    exit 1
  fi
}

mkdir -p -- "${fixture}/bin"
ln -s -- "${REPOSITORY_ROOT}/server/tests/fake-curl" "${fixture}/bin/curl"
export PATH="${fixture}/bin:${PATH}"
export FAKE_FACTORIO_ROOT="${fixture}/fake-portal"
export FACTORIO_API_BASE="https://mods.factorio.com"
export FACTORIO_USERNAME="arzter"
export FACTORIO_TOKEN="portal-token"

resolver="${GAMES}/factorio/resolve-mods.sh"

# --- portal fixtures: two mods, one with underscores in its name ---
mkdir -p -- "${FAKE_FACTORIO_ROOT}/blobs"
printf 'graftorio zip bytes\n' >"${FAKE_FACTORIO_ROOT}/blobs/graftorio2_0.4.20.zip"
printf 'even distribution bytes\n' >"${FAKE_FACTORIO_ROOT}/blobs/even_more_distribution_1.0.5.zip"

portal_fixture() {
  local name="$1" version="$2" file="$3"
  jq -n \
    --arg version "${version}" \
    --arg file "${file}" \
    --arg sha1 "$(sha1sum -- "${FAKE_FACTORIO_ROOT}/blobs/${file}" | awk '{print $1}')" \
    '{name: "x", releases: [
       {version: "0.0.1", file_name: "ancient.zip", sha1: "0000000000000000000000000000000000000000", download_url: "/dl/ancient.zip"},
       {version: $version, file_name: $file, sha1: $sha1, download_url: ("/dl/" + $file)}
     ]}' >"${FAKE_FACTORIO_ROOT}/mod-${name}.json"
}
portal_fixture graftorio2 0.4.20 graftorio2_0.4.20.zip
portal_fixture even_more_distribution 1.0.5 even_more_distribution_1.0.5.zip

cat >"${fixture}/factorio.list" <<'LIST'
# pinned portal versions
graftorio2:0.4.20
even_more_distribution:1.0.5
LIST

# --- resolve: fetch, verify, cache, heal ---
output="$("${resolver}" "${fixture}/factorio.list" "${fixture}/payload")"
grep -qx 'resolved=2' <<<"${output}"
grep -qx 'downloaded=2' <<<"${output}"
cmp -- "${FAKE_FACTORIO_ROOT}/blobs/graftorio2_0.4.20.zip" "${fixture}/payload/mods/graftorio2_0.4.20.zip"

output="$("${resolver}" "${fixture}/factorio.list" "${fixture}/payload")"
grep -qx 'kept=2' <<<"${output}"

printf 'tampered\n' >>"${fixture}/payload/mods/graftorio2_0.4.20.zip"
output="$("${resolver}" "${fixture}/factorio.list" "${fixture}/payload" 2>/dev/null)"
grep -qx 'downloaded=1' <<<"${output}"

# --- an empty list needs no portal and no credentials ---
: >"${fixture}/empty.list"
output="$(env -u FACTORIO_USERNAME -u FACTORIO_TOKEN "${resolver}" "${fixture}/empty.list" "${fixture}/empty-payload")"
grep -qx 'resolved=0' <<<"${output}"

# --- refusals ---
expect_failure "mods without credentials" \
  env -u FACTORIO_TOKEN "${resolver}" "${fixture}/factorio.list" "${fixture}/payload2"
printf 'graftorio2:9.9.9\n' >"${fixture}/missing.list"
expect_failure "a version the portal does not have" \
  "${resolver}" "${fixture}/missing.list" "${fixture}/payload2"
printf 'graftorio2@latest\n' >"${fixture}/bad.list"
expect_failure "an unpinned entry" \
  "${resolver}" "${fixture}/bad.list" "${fixture}/payload2"

# --- the session hook: mod-list.json is a function of the directory ---
(
  export FACTORIO_DATA_DIR="${fixture}/data"
  mkdir -p -- "${FACTORIO_DATA_DIR}/mods"
  cp -- "${FAKE_FACTORIO_ROOT}/blobs/"*.zip "${FACTORIO_DATA_DIR}/mods/"
  source "${GAMES}/factorio/game.sh"
  game_prepare_session
  jq -e '
    .mods[0] == {name: "base", enabled: true} and
    (.mods | map(.name)) == ["base", "even_more_distribution", "graftorio2"] and
    all(.mods[]; .enabled == true)
  ' "${FACTORIO_DATA_DIR}/mods/mod-list.json" >/dev/null
)

printf 'factorio-resolver-test: ok\n'
