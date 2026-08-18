#!/usr/bin/env bash

# The boot-time reconciliation chain (ADR-0030): read the world's pointer,
# ensure a verified local copy of the desired release, reconcile the live mod
# directory against it. Exercised exactly as start-session.sh composes it,
# against the same fake S3 the import test populates.

set -Eeuo pipefail

REPOSITORY_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPTS="${REPOSITORY_ROOT}/server/scripts"
fixture="$(mktemp -d /tmp/spawnpoint-boot-reconcile-test.XXXXXXXX)"
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
ln -s -- "${REPOSITORY_ROOT}/server/tests/fake-aws" "${fixture}/bin/aws"
export PATH="${fixture}/bin:${PATH}"
export FAKE_S3_ROOT="${fixture}/fake-s3"
export BACKUP_BUCKET="spawnpoint-test-backups"
export RELEASE_BUCKET="spawnpoint-test-releases"

# --- a world arrives the way worlds arrive: through import ---
mkdir -p -- "${fixture}/source/data/world" "${fixture}/source/pack/mods"
printf 'level fixture\n' >"${fixture}/source/data/world/level.dat"
printf 'jar one\n' >"${fixture}/source/pack/mods/alpha.jar"
printf 'jar two\n' >"${fixture}/source/pack/mods/beta.jar"
"${REPOSITORY_ROOT}/scripts/import-world.sh" \
  "${fixture}/source/data" world "${fixture}/source/pack/mods" 1.0 1.20.1 47.4.0 >/dev/null

# --- a fresh host: empty server dir, nothing cached ---
host="${fixture}/host"
mkdir -p -- "${host}"

# 1. The pointer answers with the imported desired release.
pointer_output="$(WORLD_NAME=world "${SCRIPTS}/read-release-pointer.sh" world)"
grep -qx 'desired_release=1.0' <<<"${pointer_output}"
grep -qx 'active_release=null' <<<"${pointer_output}"

# A world that was never imported is exit 3 — a state, not an error.
set +e
WORLD_NAME=ghost "${SCRIPTS}/read-release-pointer.sh" ghost >/dev/null 2>&1
[[ $? -eq 3 ]] || {
  printf 'expected exit 3 for an absent pointer\n' >&2
  exit 1
}
set -e

# 2. First download fetches everything; the payload is complete and verified.
download_output="$("${SCRIPTS}/download-release.sh" 1.0 "${host}/releases/1.0")"
grep -qx 'downloaded=2' <<<"${download_output}"
grep -qx 'kept=0' <<<"${download_output}"
cmp -- "${fixture}/source/pack/mods/alpha.jar" "${host}/releases/1.0/mods/alpha.jar"

# 3. Reconcile materialises the live mod directory from the payload.
SERVER_PROJECT_DIRECTORY="${host}" \
  "${SCRIPTS}/reconcile-release.sh" "${host}/releases/1.0/manifest.json" >/dev/null
cmp -- "${fixture}/source/pack/mods/beta.jar" "${host}/mods/beta.jar"
[[ -f "${host}/mods/.spawnpoint-release.json" ]]

# --- the boring boot: nothing changed, nothing downloads ---
second_output="$("${SCRIPTS}/download-release.sh" 1.0 "${host}/releases/1.0")"
grep -qx 'downloaded=0' <<<"${second_output}"
grep -qx 'kept=2' <<<"${second_output}"

# --- self-healing: a tampered cache entry is refetched, not trusted ---
printf 'corrupted\n' >>"${host}/releases/1.0/mods/alpha.jar"
heal_output="$("${SCRIPTS}/download-release.sh" 1.0 "${host}/releases/1.0")"
grep -qx 'downloaded=1' <<<"${heal_output}"
grep -qx 'kept=1' <<<"${heal_output}"
cmp -- "${fixture}/source/pack/mods/alpha.jar" "${host}/releases/1.0/mods/alpha.jar"

# --- refusals ---
expect_failure "an unpublished release" \
  "${SCRIPTS}/download-release.sh" 9.9 "${host}/releases/9.9"

corrupt="${FAKE_S3_ROOT}/${RELEASE_BUCKET}/releases/1.0/mods/beta.jar"
printf 'evil bytes\n' >"${corrupt}"
rm -rf -- "${host}/releases/1.0/mods/beta.jar"
expect_failure "a bucket object that does not match the manifest" \
  "${SCRIPTS}/download-release.sh" 1.0 "${host}/releases/1.0"

printf 'boot-reconcile-test: ok\n'
