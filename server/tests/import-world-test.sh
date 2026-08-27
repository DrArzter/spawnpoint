#!/usr/bin/env bash

# The import contract: one command turns an existing world plus its mods into a
# published release, a verified archive, and an ADR-0030 pointer — and refuses
# to run twice, because changing an imported world's release is a promotion.

set -Eeuo pipefail

REPOSITORY_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
fixture="$(mktemp -d /tmp/spawnpoint-import-test.XXXXXXXX)"
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

# --- fixture: a world and the mods it runs on ---
mkdir -p -- "${fixture}/data/world/region" "${fixture}/pack/mods"
printf 'level fixture\n' >"${fixture}/data/world/level.dat"
printf 'region fixture\n' >"${fixture}/data/world/region/r.0.0.mca"
printf 'jar one\n' >"${fixture}/pack/mods/alpha.jar"
printf 'jar two\n' >"${fixture}/pack/mods/beta.jar"

# --- import: the happy path ---
import_output="$(
  "${REPOSITORY_ROOT}/scripts/import-world.sh" \
    "${fixture}/data" world "${fixture}/pack/mods" 1.0 1.20.1 47.4.0
)"
grep -qx 'result=imported' <<<"${import_output}"
grep -qx 'release_result=uploaded' <<<"${import_output}"
grep -qx 'desired_release=1.0' <<<"${import_output}"

# Everything the import claims to have created exists in the fake bucket layout.
release_root="${FAKE_S3_ROOT}/${RELEASE_BUCKET}"
[[ -f "${release_root}/releases/1.0/manifest.json" ]]
[[ -f "${release_root}/releases/1.0/mods/alpha.jar" ]]
[[ -f "${release_root}/releases/1.0/mods/beta.jar" ]]
cmp -- "${fixture}/pack/mods/alpha.jar" "${release_root}/releases/1.0/mods/alpha.jar"
archive_key="$(awk -F= '$1 == "archive_key" { print $2 }' <<<"${import_output}")"
[[ -f "${FAKE_S3_ROOT}/${BACKUP_BUCKET}/${archive_key}" ]]

# The pointer is ADR-0030's shape: desired set by the import, active null
# because nothing has passed a health check yet.
pointer="${release_root}/worlds/world/release.json"
[[ -f "${pointer}" ]]
jq -e '
  .schema_version == 1 and
  .world == "world" and
  .desired_release == "1.0" and
  .active_release == null
' "${pointer}" >/dev/null

# --- a second world importing the SAME pack reuses the release ---
mkdir -p -- "${fixture}/data2/world_two"
printf 'second level\n' >"${fixture}/data2/world_two/level.dat"
second_output="$(
  "${REPOSITORY_ROOT}/scripts/import-world.sh" \
    "${fixture}/data2" world_two "${fixture}/pack/mods" 1.0 1.20.1 47.4.0
)"
grep -qx 'result=imported' <<<"${second_output}"
grep -qx 'release_result=already_present' <<<"${second_output}"
[[ -f "${release_root}/worlds/world_two/release.json" ]]

# --- refusals ---
expect_failure "re-importing an existing world" \
  "${REPOSITORY_ROOT}/scripts/import-world.sh" \
  "${fixture}/data" world "${fixture}/pack/mods" 1.1 1.20.1 47.4.0

printf 'tampered\n' >>"${fixture}/pack/mods/beta.jar"
mkdir -p -- "${fixture}/data3/world_three"
printf 'third level\n' >"${fixture}/data3/world_three/level.dat"
expect_failure "same release version with different mod bytes" \
  "${REPOSITORY_ROOT}/scripts/import-world.sh" \
  "${fixture}/data3" world_three "${fixture}/pack/mods" 1.0 1.20.1 47.4.0
[[ ! -e "${release_root}/worlds/world_three/release.json" ]]

expect_failure "a data-dir without the named world" \
  "${REPOSITORY_ROOT}/scripts/import-world.sh" \
  "${fixture}/pack" ghost "${fixture}/pack/mods" 2.0 1.20.1 47.4.0

# --- the game axis: a factorio world imports through the same five steps,
#     judged by its own sentinel and carrying its game in the manifest ---
mkdir -p -- "${fixture}/fdata/saves" "${fixture}/fpack/mods"
printf 'save bytes\n' >"${fixture}/fdata/saves/spawnpoint.zip"
printf 'mod zip bytes\n' >"${fixture}/fpack/mods/alien-biomes_0.6.8.zip"
factorio_output="$(
  "${REPOSITORY_ROOT}/scripts/import-world.sh" \
    "${fixture}/fdata" factorio "${fixture}/fpack/mods" 3.0 2.0.77 2.0.77 factorio
)"
grep -qx 'result=imported' <<<"${factorio_output}"
grep -qx 'game=factorio' <<<"${factorio_output}"
jq -e '.game == "factorio" and .loader.type == "factorio"' \
  "${release_root}/releases/3.0/manifest.json" >/dev/null
[[ -f "${release_root}/releases/3.0/mods/alien-biomes_0.6.8.zip" ]]
[[ -f "${release_root}/worlds/factorio/release.json" ]]
factorio_archive_key="$(awk -F= '$1 == "archive_key" { print $2 }' <<<"${factorio_output}")"
[[ -f "${FAKE_S3_ROOT}/${BACKUP_BUCKET}/${factorio_archive_key}" ]]

# a factorio import is judged by factorio's sentinel, not level.dat
mkdir -p -- "${fixture}/fempty/saves"
expect_failure "a factorio data dir with no save" \
  "${REPOSITORY_ROOT}/scripts/import-world.sh" \
  "${fixture}/fempty" factorio-two "${fixture}/fpack/mods" 3.1 2.0.77 2.0.77 factorio

expect_failure "an unknown game" \
  "${REPOSITORY_ROOT}/scripts/import-world.sh" \
  "${fixture}/fdata" factorio-three "${fixture}/fpack/mods" 3.2 1.0 1.0 heroes

printf 'import-world-test: ok\n'
