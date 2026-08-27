#!/usr/bin/env bash

# The adoption helpers (docs/runbook.md): the offline-UUID remap that lets a
# player keep their inventory when a world moves to online-mode=false, and the
# factorio pin derivation that turns a mods directory into a profile pin list.

set -Eeuo pipefail

REPOSITORY_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
GAMES="${REPOSITORY_ROOT}/server/games"
fixture="$(mktemp -d /tmp/spawnpoint-adoption-test.XXXXXXXX)"
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

REMAP="${GAMES}/minecraft/remap-offline-uuids.sh"
DERIVE="${GAMES}/factorio/derive-pins.sh"

# --- remap: the happy path, with the golden offline UUID ---
# Java's UUID.nameUUIDFromBytes("OfflinePlayer:Arzter") — computed once,
# hardcoded so a regression in the derivation cannot re-derive its own bug.
offline_arzter="785b4546-f02b-3b2b-b961-74e4800cac0a"
mojang="069a79f4-44e9-4726-a5be-fca90e38aaf5"

world="${fixture}/world"
mkdir -p -- "${world}/playerdata" "${world}/advancements" "${world}/stats"
printf 'inventory\n' >"${world}/playerdata/${mojang}.dat"
printf 'old inventory\n' >"${world}/playerdata/${mojang}.dat_old"
printf 'advancements\n' >"${world}/advancements/${mojang}.json"
printf 'stats\n' >"${world}/stats/${mojang}.json"

output="$("${REMAP}" "${world}" Arzter)"
grep -qx 'result=remapped' <<<"${output}"
grep -qx "source_uuid=${mojang}" <<<"${output}"
grep -qx "target_uuid=${offline_arzter}" <<<"${output}"
grep -qx 'moved=4' <<<"${output}"
[[ "$(cat "${world}/playerdata/${offline_arzter}.dat")" == "inventory" ]]
[[ -f "${world}/playerdata/${offline_arzter}.dat_old" ]]
[[ -f "${world}/advancements/${offline_arzter}.json" ]]
[[ -f "${world}/stats/${offline_arzter}.json" ]]
[[ ! -e "${world}/playerdata/${mojang}.dat" ]]

# a second run finds the work already done
second="$("${REMAP}" "${world}" Arzter)"
grep -qx 'result=already_offline' <<<"${second}"

# --- remap: ambiguity refuses instead of guessing ---
crowded="${fixture}/crowded"
mkdir -p -- "${crowded}/playerdata"
printf 'a\n' >"${crowded}/playerdata/11111111-1111-4111-8111-111111111111.dat"
printf 'b\n' >"${crowded}/playerdata/22222222-2222-4222-8222-222222222222.dat"
expect_failure "two candidates and no explicit source" "${REMAP}" "${crowded}" Arzter
explicit="$("${REMAP}" "${crowded}" Arzter 11111111-1111-4111-8111-111111111111)"
grep -qx 'moved=1' <<<"${explicit}"
[[ "$(cat "${crowded}/playerdata/${offline_arzter}.dat")" == "a" ]]

# --- remap: a collision refuses before anything moved ---
collision="${fixture}/collision"
mkdir -p -- "${collision}/playerdata"
printf 'source\n' >"${collision}/playerdata/${mojang}.dat"
printf 'target\n' >"${collision}/playerdata/${offline_arzter}.dat"
expect_failure "destination already exists" "${REMAP}" "${collision}" Arzter "${mojang}"
[[ "$(cat "${collision}/playerdata/${mojang}.dat")" == "source" ]]

expect_failure "an empty world directory" "${REMAP}" "${fixture}/nowhere" Arzter
expect_failure "an invalid player name" "${REMAP}" "${world}" 'no spaces allowed'

# --- derive-pins: the mods directory is the pin list ---
mods="${fixture}/mods"
mkdir -p -- "${mods}"
printf 'zip\n' >"${mods}/alien-biomes_0.6.8.zip"
printf 'zip\n' >"${mods}/even-distribution_2.1.2.zip"
printf '{}\n' >"${mods}/mod-list.json"
pins="$("${DERIVE}" "${mods}")"
[[ "${pins}" == 'alien-biomes:0.6.8
even-distribution:2.1.2' ]]

# an empty directory derives an empty list — the vanilla adoption
empty="${fixture}/empty-mods"
mkdir -p -- "${empty}"
[[ -z "$("${DERIVE}" "${empty}")" ]]

# a file that cannot be pinned refuses the whole derivation, by name
printf 'zip\n' >"${mods}/renamed by hand.zip"
if derive_error="$("${DERIVE}" "${mods}" 2>&1)"; then
  printf 'expected failure: unpinnable file\n' >&2
  exit 1
fi
grep -q 'renamed by hand.zip' <<<"${derive_error}"

printf 'adoption-tools-test: ok\n'
