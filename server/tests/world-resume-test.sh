#!/usr/bin/env bash

# A world's home between sessions is S3 (ADR-0048). A launched host starts
# empty and is terminated after its session, and the next session of the same
# world may land on another host, or back on one that still holds an older
# copy. Each start must open the newest archive of the current wipe.

set -Eeuo pipefail

repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
scripts="${repository_root}/server/scripts"
fixture="$(mktemp -d /tmp/spawnpoint-world-resume-test.XXXXXXXX)"
cleanup() {
  rm -rf -- "${fixture}"
}
trap cleanup EXIT

# A `! grep` line never fails a set -e script, so absence is asserted here.
refute_line() {
  if grep -q -- "$1" <<<"$2"; then
    printf 'unexpected line matching %s\n' "$1" >&2
    exit 1
  fi
}

expect_failure() {
  local label="$1"
  shift
  if "$@" >/dev/null 2>&1; then
    printf 'expected failure: %s\n' "${label}" >&2
    exit 1
  fi
}

world_id="minecraft-rostik-1a2b3c4d"
generation="gen-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
mkdir -p -- "${fixture}/bin" "${fixture}/s3/backups" "${fixture}/archives"
ln -s -- "${repository_root}/server/tests/fake-aws" "${fixture}/bin/aws"
export PATH="${fixture}/bin:${PATH}"
export FAKE_S3_ROOT="${fixture}/s3"
export BACKUP_BUCKET=backups
export AWS_REGION=eu-central-1

# The world as the host catalog projects it from the registry: one wipe, or a
# wipe restored from a backup of an earlier one.
catalog_for() {
  local current="$1" restore="${2:-}"
  jq --arg id "${world_id}" --arg generation "${current}" --argjson restore "${restore:-null}" '
    .worlds += [{
      id: $id, display_name: "Rostik", profile_id: "industrial", game: "minecraft",
      connectivity: "zerotier", storage_layout: "generation", generation_id: $generation, release: "1.2"
    } + (if $restore == null then {} else {restore: $restore} end)]
  ' "${repository_root}/server/worlds/catalog.json" >"${fixture}/catalog.json"
}
catalog_for "${generation}"
export SPAWNPOINT_WORLD_CATALOG="${fixture}/catalog.json"

# One host's view: its own worlds directory, as a launched host has its own disk.
prepare_on() {
  SPAWNPOINT_WORLDS_DIRECTORY="${fixture}/hosts/$1" "${scripts}/prepare-world.sh" "${world_id}"
}
world_on() {
  printf '%s' "${fixture}/hosts/$1/${world_id}/generations/$2"
}

# What a stop does after the game has stopped: archive, upload, then record
# which archive the copy on this host now is (stop-session.sh).
stop_on() {
  local host="$1" current="$2" directory archive_output archive upload_output
  directory="$(world_on "${host}" "${current}")"
  sleep 1 # archive names carry the second they were taken
  archive_output="$(
    SPAWNPOINT_GAME=minecraft SERVER_DATA_DIR="${directory}/data" SERVER_BACKUP_DIR="${fixture}/archives/${host}" \
      WORLD_NAME="${world_id}" WORLD_GENERATION_ID="${current}" "${scripts}/archive-world.sh"
  )"
  archive="$(awk -F= '$1 == "archive" { print substr($0, index($0, "=") + 1) }' <<<"${archive_output}")"
  upload_output="$(SPAWNPOINT_GAME=minecraft WORLD_NAME="${world_id}" WORLD_GENERATION_ID="${current}" \
    "${scripts}/upload-world-backup.sh" "${archive}")"
  (
    # shellcheck source=../scripts/_worlds.sh
    source "${scripts}/_worlds.sh"
    record_world_archive "${directory}" \
      "$(awk -F= '$1 == "object_key" { print substr($0, index($0, "=") + 1) }' <<<"${upload_output}")" \
      "$(awk -F= '$1 == "checksum" { print substr($0, index($0, "=") + 1) }' <<<"${upload_output}")"
  )
  awk -F= '$1 == "object_key" { print substr($0, index($0, "=") + 1) }' <<<"${upload_output}"
}

play() {
  mkdir -p -- "$1/data/world"
  printf '%s\n' "$2" >"$1/data/world/level.dat"
}

recorded_key() {
  jq -r '.key // "null"' "$1/.spawnpoint-archive.json"
}

# --- a new wipe with no archive starts empty, and says so in its record ---
output="$(prepare_on a)"
grep -Fxq 'result=prepared' <<<"${output}"
a_world="$(world_on a "${generation}")"
[[ -z "$(ls -A -- "${a_world}/data")" ]]
[[ "$(recorded_key "${a_world}")" == "null" ]]

play "${a_world}" "session one"
first_key="$(stop_on a "${generation}")"
[[ "$(recorded_key "${a_world}")" == "${first_key}" ]]

# --- the next session on a new host opens the newest archive, not an empty world ---
output="$(prepare_on b)"
grep -Fxq "resumed_from=${first_key}" <<<"${output}"
b_world="$(world_on b "${generation}")"
grep -Fxq 'session one' "${b_world}/data/world/level.dat"
[[ "$(recorded_key "${b_world}")" == "${first_key}" ]]

play "${b_world}" "session two"
second_key="$(stop_on b "${generation}")"

# --- the host that held the world before has an older copy: it is set aside, not used ---
output="$(prepare_on a 2>"${fixture}/a-warnings")"
grep -Fxq "resumed_from=${second_key}" <<<"${output}"
grep -Fxq 'session two' "${a_world}/data/world/level.dat"
superseded="$(awk -F= '$1 == "superseded" { print substr($0, index($0, "=") + 1) }' <<<"${output}")"
grep -Fxq 'session one' "${superseded}/data/world/level.dat"
grep -Fq 'older copy' "${fixture}/a-warnings"

# --- a copy that is the newest archive is used as it is ---
output="$(prepare_on b)"
grep -Fxq 'result=already_prepared' <<<"${output}"
refute_line '^resumed_from=' "${output}"

# --- a copy with progress no backup has yet stays, while it is still the newest's lineage ---
play "${b_world}" "session three, not yet backed up"
output="$(prepare_on b)"
grep -Fxq 'result=already_prepared' <<<"${output}"
grep -Fxq 'session three, not yet backed up' "${b_world}/data/world/level.dat"

# --- a listing S3 does not answer refuses the start, and creates nothing ---
expect_failure "a start whose archives cannot be listed" env FAKE_S3_LIST_FAIL=true \
  SPAWNPOINT_WORLDS_DIRECTORY="${fixture}/hosts/c" "${scripts}/prepare-world.sh" "${world_id}"
[[ ! -e "$(world_on c "${generation}")" ]]

# --- a copy prepared before copies recorded their archive is kept, and the start says so ---
cp -a -- "${fixture}/hosts/a" "${fixture}/hosts/d"
rm -f -- "$(world_on d "${generation}")/.spawnpoint-archive.json"
rm -rf -- "${fixture}/hosts/d/${world_id}/generations/.${generation}.superseded"
play "$(world_on d "${generation}")" "a copy from before records"
output="$(prepare_on d 2>"${fixture}/d-warnings")"
grep -Fxq 'result=already_prepared' <<<"${output}"
grep -Fq 'predates archive records' "${fixture}/d-warnings"

# --- without a backup bucket, as on a workstation, the host's copy is all there is ---
output="$(env -u BACKUP_BUCKET SPAWNPOINT_WORLDS_DIRECTORY="${fixture}/hosts/g" "${scripts}/prepare-world.sh" "${world_id}")"
grep -Fxq 'result=prepared' <<<"${output}"
refute_line '^resumed_from=' "${output}"

# --- a restored wipe begins from its backup, then lives on its own archives ---
restored="gen-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
second_checksum="$(sed -E 's/^.*-([0-9a-f]{64})\.tar\.zst$/\1/' <<<"${second_key}")"
catalog_for "${restored}" "$(jq -cn --arg key "${second_key}" --arg checksum "${second_checksum}" --arg source "${generation}" \
  '{backup_key: $key, checksum: $checksum, source_generation_id: $source}')"
output="$(prepare_on e)"
refute_line '^resumed_from=' "${output}"
e_world="$(world_on e "${restored}")"
grep -Fxq 'session two' "${e_world}/data/world/level.dat"
[[ "$(recorded_key "${e_world}")" == "${second_key}" ]]
play "${e_world}" "after the restore"
restored_key="$(stop_on e "${restored}")"
output="$(prepare_on f)"
grep -Fxq "resumed_from=${restored_key}" <<<"${output}"
grep -Fxq 'after the restore' "$(world_on f "${restored}")/data/world/level.dat"

printf 'world resume test passed\n'
