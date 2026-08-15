#!/usr/bin/env bash

# The release pipeline's safety properties: a manifest is immutable and schema-valid,
# and reconciliation refuses bad input while never destroying the mods it replaces.

set -Eeuo pipefail

REPOSITORY_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPTS="${REPOSITORY_ROOT}/server/scripts"
fixture="$(mktemp -d /tmp/spawnpoint-release-test.XXXXXXXX)"
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

# --- fixture release payload ---
mkdir -p -- "${fixture}/release/mods" "${fixture}/server"
printf 'jar one\n' >"${fixture}/release/mods/alpha.jar"
printf 'jar two, different bytes\n' >"${fixture}/release/mods/beta.jar"
printf 'not a mod\n' >"${fixture}/release/mods/readme.txt"

manifest="${fixture}/release/manifest.json"

# --- build: happy path ---
build_output="$("${SCRIPTS}/build-release-manifest.sh" 1.0 1.20.1 47.4.0 "${fixture}/release/mods" "${manifest}")"
grep -qx 'result=manifest_created' <<<"${build_output}"
grep -qx 'mods=2' <<<"${build_output}"

# The manifest records exactly the JARs, with real digests, and validates against
# the same rules reconcile-release.sh enforces.
jq -e '
  .schema_version == 1 and
  .release == "1.0" and
  .loader == {type: "forge", version: "47.4.0"} and
  ([.server.mods[].file] == ["alpha.jar", "beta.jar"]) and
  all(.server.mods[]; .sha256 | test("^[0-9a-f]{64}$"))
' "${manifest}" >/dev/null
expected_sha="$(sha256sum -- "${fixture}/release/mods/alpha.jar" | awk '{print $1}')"
[[ "$(jq -r '.server.mods[0].sha256' "${manifest}")" == "${expected_sha}" ]]

# --- build: refusals ---
expect_failure "manifest is immutable" \
  "${SCRIPTS}/build-release-manifest.sh" 1.1 1.20.1 47.4.0 "${fixture}/release/mods" "${manifest}"
expect_failure "release must be MAJOR.MINOR" \
  "${SCRIPTS}/build-release-manifest.sh" v1 1.20.1 47.4.0 "${fixture}/release/mods" "${fixture}/release/bad.json"
mkdir -p -- "${fixture}/empty-mods"
empty_manifest="${fixture}/release/empty.json"
empty_output="$(
  "${SCRIPTS}/build-release-manifest.sh" \
    1.1 1.20.1 47.4.0 "${fixture}/empty-mods" "${empty_manifest}"
)"
grep -qx 'mods=0' <<<"${empty_output}"
jq -e '.server.mods == []' "${empty_manifest}" >/dev/null

# --- reconcile: fresh target ---
target="${fixture}/server/mods"
reconcile_output="$("${SCRIPTS}/reconcile-release.sh" "${manifest}" "${target}")"
grep -qx 'result=reconciled' <<<"${reconcile_output}"
grep -qx 'mods=2' <<<"${reconcile_output}"
cmp -- "${fixture}/release/mods/alpha.jar" "${target}/alpha.jar"
cmp -- "${manifest}" "${target}/.spawnpoint-release.json"
[[ ! -e "${target}/readme.txt" ]]

# Reconcile keeps its lock file beside the target; stage and backup directories
# must not survive, in success or in failure.
no_stage_or_backup_litter() {
  [[ -z "$(find "${fixture}/server" -mindepth 1 -maxdepth 1 -name '.mods.*' -print -quit)" ]]
}

# --- reconcile: replaces an existing target exactly, and cleans up its backup ---
printf 'stale mod that must disappear\n' >"${target}/stale.jar"
"${SCRIPTS}/reconcile-release.sh" "${manifest}" "${target}" >/dev/null
[[ ! -e "${target}/stale.jar" ]]
no_stage_or_backup_litter

# --- reconcile: a tampered payload is refused and the live target is untouched ---
printf 'tampered\n' >>"${fixture}/release/mods/beta.jar"
before="$(find "${target}" -type f -exec sha256sum {} + | sort)"
expect_failure "tampered payload" "${SCRIPTS}/reconcile-release.sh" "${manifest}" "${target}"
after="$(find "${target}" -type f -exec sha256sum {} + | sort)"
[[ "${before}" == "${after}" ]]
no_stage_or_backup_litter
# restore the payload for the remaining cases
printf 'jar two, different bytes\n' >"${fixture}/release/mods/beta.jar"

# --- reconcile: refusals ---
expect_failure "target must be named mods" \
  "${SCRIPTS}/reconcile-release.sh" "${manifest}" "${fixture}/server/not-mods"
expect_failure "target must not replace its own source" \
  "${SCRIPTS}/reconcile-release.sh" "${manifest}" "${fixture}/release/mods"

tampered_manifest="${fixture}/tampered.json"
jq '.server.mods[1].file = .server.mods[0].file' "${manifest}" >"${tampered_manifest}"
expect_failure "duplicate manifest entries" \
  "${SCRIPTS}/reconcile-release.sh" "${tampered_manifest}" "${target}"

jq '.loader.type = "fabric"' "${manifest}" >"${tampered_manifest}"
expect_failure "wrong loader type" \
  "${SCRIPTS}/reconcile-release.sh" "${tampered_manifest}" "${target}"

# --- reconcile: a concurrent run is refused, not raced ---
lock_file="${fixture}/server/.spawnpoint-mods.reconcile.lock"
exec 8>"${lock_file}"
flock -n 8
expect_failure "second reconciliation while one holds the lock" \
  "${SCRIPTS}/reconcile-release.sh" "${manifest}" "${target}"
exec 8>&-

printf 'release-reconcile-test: ok\n'
