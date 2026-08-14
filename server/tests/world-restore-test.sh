#!/usr/bin/env bash

# The restore path's safety properties: verify-archive.sh rejects everything the
# backup design says it must, and restore-world.sh can only write somewhere new.

set -Eeuo pipefail

REPOSITORY_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPTS="${REPOSITORY_ROOT}/server/scripts"
fixture="$(mktemp -d /tmp/spawnpoint-restore-test.XXXXXXXX)"
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

checksum_beside() {
  local archive="$1"
  (
    cd -- "$(dirname -- "${archive}")"
    sha256sum -- "$(basename -- "${archive}")" >"$(basename -- "${archive}").sha256"
  )
}

# --- fixture world, archived by the real script ---
mkdir -p -- "${fixture}/data/world/region" "${fixture}/data/world_nether" "${fixture}/backups"
printf 'level fixture\n' >"${fixture}/data/world/level.dat"
printf 'region fixture\n' >"${fixture}/data/world/region/r.0.0.mca"
printf 'nether fixture\n' >"${fixture}/data/world_nether/marker"

archive_output="$(
  SERVER_DATA_DIR="${fixture}/data" \
  SERVER_BACKUP_DIR="${fixture}/backups" \
  WORLD_NAME=world \
    "${SCRIPTS}/archive-world.sh"
)"
archive="$(awk -F= '$1 == "archive" { print $2 }' <<<"${archive_output}")"
grep -qx 'world_directories=2' <<<"${archive_output}"

# --- restore: happy path is byte-identical ---
restore_output="$("${SCRIPTS}/restore-world.sh" "${archive}" "${fixture}/restored")"
grep -qx 'result=restored' <<<"${restore_output}"
diff -r -- "${fixture}/data" "${fixture}/restored"

# --- restore: refusals ---
expect_failure "non-empty destination" \
  "${SCRIPTS}/restore-world.sh" "${archive}" "${fixture}/restored"

mkdir -p -- "${fixture}/live-server/data"
expect_failure "the live data directory" \
  env SERVER_PROJECT_DIRECTORY="${fixture}/live-server" \
  "${SCRIPTS}/restore-world.sh" "${archive}" "${fixture}/live-server/data"

# --- verify: checksum is mandatory and must match ---
orphan="${fixture}/backups/orphan.tar.zst"
cp -- "${archive}" "${orphan}"
expect_failure "missing checksum" "${SCRIPTS}/verify-archive.sh" "${orphan}"
printf '%064d  %s\n' 0 "$(basename -- "${archive}")" >"${archive}.sha256"
expect_failure "corrupted checksum" "${SCRIPTS}/verify-archive.sh" "${archive}"
checksum_beside "${archive}"
"${SCRIPTS}/verify-archive.sh" "${archive}" >/dev/null

# --- verify: truncation is caught even with a matching checksum ---
truncated="${fixture}/backups/truncated.tar.zst"
head -c 100 "${archive}" >"${truncated}"
checksum_beside "${truncated}"
expect_failure "truncated archive with a fresh checksum" \
  "${SCRIPTS}/verify-archive.sh" "${truncated}"

# --- verify: an archive without the world's level.dat is not a world backup ---
mkdir -p -- "${fixture}/impostor/world"
printf 'no level.dat here\n' >"${fixture}/impostor/world/other-file"
no_level="${fixture}/backups/no-level.tar.zst"
tar --create --zstd --file "${no_level}" --directory "${fixture}/impostor" world
checksum_beside "${no_level}"
expect_failure "archive without level.dat" \
  env WORLD_NAME=world "${SCRIPTS}/verify-archive.sh" "${no_level}"

# --- verify: path traversal entries are rejected outright ---
printf 'escape attempt\n' >"${fixture}/outside.txt"
evil="${fixture}/backups/evil.tar.zst"
tar --absolute-names --create --zstd --file "${evil}" \
  --directory "${fixture}/impostor" ../outside.txt
checksum_beside "${evil}"
expect_failure "path traversal entry" \
  env WORLD_NAME=world "${SCRIPTS}/verify-archive.sh" "${evil}"

printf 'world-restore-test: ok\n'
