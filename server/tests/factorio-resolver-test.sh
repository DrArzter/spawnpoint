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

# The portal's /full shape: releases carry info_json with the engine series and
# the dependency list.
portal_fixture() {
  local name="$1" version="$2" file="$3" engine="${4:-2.0}"
  shift 4 2>/dev/null || shift $#
  local dependencies
  dependencies="$(printf '%s\n' "$@" | jq -R . | jq -sc 'map(select(length > 0))')"
  jq -n \
    --arg version "${version}" \
    --arg file "${file}" \
    --arg engine "${engine}" \
    --argjson dependencies "${dependencies}" \
    --arg sha1 "$(sha1sum -- "${FAKE_FACTORIO_ROOT}/blobs/${file}" | awk '{print $1}')" \
    '{name: "x", releases: [
       {version: "0.0.1", file_name: "ancient.zip", sha1: "0000000000000000000000000000000000000000",
        download_url: "/dl/ancient.zip", info_json: {factorio_version: "1.1", dependencies: []}},
       {version: $version, file_name: $file, sha1: $sha1, download_url: ("/dl/" + $file),
        info_json: {factorio_version: $engine, dependencies: $dependencies}}
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
grep -qx 'engine_check=skipped' <<<"${output}"
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

# --- the pack as a set: engine series, required dependencies, conflicts ---
FACTORIO_TARGET_VERSION=2.0.77 "${resolver}" "${fixture}/factorio.list" "${fixture}/engine-ok" >/dev/null
engine_output="$(FACTORIO_TARGET_VERSION=2.0 "${resolver}" "${fixture}/factorio.list" "${fixture}/engine-ok2")"
grep -qx 'engine_check=2.0' <<<"${engine_output}"

# a mod release built for another series is refused, naming both versions
printf 'legacy zip\n' >"${FAKE_FACTORIO_ROOT}/blobs/legacy_1.0.0.zip"
portal_fixture legacy 1.0.0 legacy_1.0.0.zip 1.1
printf 'legacy:1.0.0\n' >"${fixture}/legacy.list"
if engine_error="$(FACTORIO_TARGET_VERSION=2.0.77 "${resolver}" "${fixture}/legacy.list" "${fixture}/legacy-payload" 2>&1)"; then
  printf 'expected failure: a mod for another engine series\n' >&2
  exit 1
fi
grep -q 'declares factorio 1.1' <<<"${engine_error}"
grep -q '2.0' <<<"${engine_error}"

# a required dependency missing from the list is refused by name
printf 'dependent zip\n' >"${FAKE_FACTORIO_ROOT}/blobs/dependent_1.0.0.zip"
portal_fixture dependent 1.0.0 dependent_1.0.0.zip 2.0 "base >= 2.0" "helper >= 1.2.0" "? optional-thing >= 9.9"
printf 'dependent:1.0.0\n' >"${fixture}/dependent.list"
if dependency_error="$("${resolver}" "${fixture}/dependent.list" "${fixture}/dependent-payload" 2>&1)"; then
  printf 'expected failure: a missing required dependency\n' >&2
  exit 1
fi
grep -q 'requires helper' <<<"${dependency_error}"

# with the dependency pinned it resolves, and base plus optional entries are
# not treated as missing mods
printf 'helper zip\n' >"${FAKE_FACTORIO_ROOT}/blobs/helper_1.2.0.zip"
portal_fixture helper 1.2.0 helper_1.2.0.zip 2.0
printf 'dependent:1.0.0\nhelper:1.2.0\n' >"${fixture}/pack.list"
pack_output="$("${resolver}" "${fixture}/pack.list" "${fixture}/pack-payload")"
grep -qx 'resolved=2' <<<"${pack_output}"
grep -qx 'required_dependencies=2' <<<"${pack_output}"

# a version constraint the pinned version does not satisfy is refused
printf 'helper old zip\n' >"${FAKE_FACTORIO_ROOT}/blobs/helper_1.1.0.zip"
portal_fixture helper-old 1.1.0 helper_1.1.0.zip 2.0
mv -- "${FAKE_FACTORIO_ROOT}/mod-helper-old.json" "${FAKE_FACTORIO_ROOT}/mod-helper.json"
printf 'dependent:1.0.0\nhelper:1.1.0\n' >"${fixture}/old-pack.list"
if constraint_error="$("${resolver}" "${fixture}/old-pack.list" "${fixture}/old-payload" 2>&1)"; then
  printf 'expected failure: an unsatisfied version constraint\n' >&2
  exit 1
fi
grep -q 'requires helper >= 1.2.0' <<<"${constraint_error}"

# two mods that refuse to load beside each other are refused as a pair
printf 'exclusive zip\n' >"${FAKE_FACTORIO_ROOT}/blobs/exclusive_1.0.0.zip"
portal_fixture exclusive 1.0.0 exclusive_1.0.0.zip 2.0 "! graftorio2"
printf 'exclusive:1.0.0\ngraftorio2:0.4.20\n' >"${fixture}/conflict.list"
if conflict_error="$("${resolver}" "${fixture}/conflict.list" "${fixture}/conflict-payload" 2>&1)"; then
  printf 'expected failure: incompatible mods pinned together\n' >&2
  exit 1
fi
grep -q 'cannot load beside graftorio2' <<<"${conflict_error}"

# --- the profile seam: resolve-profile-mods dispatches to this resolver when
#     the profile names factorio, with no container anywhere in the path ---
config="${fixture}/factorio-config"
mkdir -p -- "${config}/profiles/factorio-modded/extras"
git -C "${config}" init --quiet
git -C "${config}" remote add origin https://github.com/example/factorio-config.git
cat >"${config}/profiles/factorio-modded/profile.json" <<'EOF'
{"schema_version":1,"game":"factorio","id":"factorio-modded","factorio_version":"2.0.77","runtime":{"image":"registry.example.invalid/factorio:9.9.9@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},"loader":{"type":"factorio","version":null},"mods":{"source":"extras/mod-pins.txt"}}
EOF
cp -- "${fixture}/factorio.list" "${config}/profiles/factorio-modded/extras/mod-pins.txt"
git -C "${config}" add profiles
git -C "${config}" -c user.name=Test -c user.email=test@example.invalid commit --quiet -m profiles

profile_output="$(
  "${REPOSITORY_ROOT}/server/scripts/resolve-profile-mods.sh" \
    "${config}/profiles/factorio-modded" "${fixture}/profile-payload/mods"
)"
grep -qx 'game=factorio' <<<"${profile_output}"
grep -qx 'mods=2' <<<"${profile_output}"
cmp -- "${FAKE_FACTORIO_ROOT}/blobs/graftorio2_0.4.20.zip" \
  "${fixture}/profile-payload/mods/graftorio2_0.4.20.zip"

expect_failure "resolving into an existing output directory" \
  "${REPOSITORY_ROOT}/server/scripts/resolve-profile-mods.sh" \
  "${config}/profiles/factorio-modded" "${fixture}/profile-payload/mods"

printf 'factorio-resolver-test: ok\n'
