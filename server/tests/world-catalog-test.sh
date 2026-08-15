#!/usr/bin/env bash

set -Eeuo pipefail

repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
scripts="${repository_root}/server/scripts"
fixture="$(mktemp -d /tmp/spawnpoint-world-catalog-test.XXXXXXXX)"
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

export SPAWNPOINT_WORLDS_DIRECTORY="${fixture}/worlds"

main_output="$("${scripts}/world-profile.sh" main)"
grep -Fxq 'world_id=main' <<<"${main_output}"
grep -Fxq 'profile_id=main' <<<"${main_output}"
grep -Fxq 'profile_commit=0791ac0810c65fca3ca0517b9fbbbfe5023d0355' <<<"${main_output}"

vanilla_output="$("${scripts}/world-profile.sh" vanilla)"
grep -Fxq 'profile_id=vanilla-forge' <<<"${vanilla_output}"
expect_failure "unknown world" "${scripts}/world-profile.sh" missing
expect_failure "invalid world id" "${scripts}/world-profile.sh" '../main'

prepare_output="$("${scripts}/prepare-world.sh" main)"
grep -Fxq 'result=prepared' <<<"${prepare_output}"
[[ -d "${fixture}/worlds/main/data" ]]
[[ -d "${fixture}/worlds/main/mods" ]]
jq -e '
  .world_id == "main" and
  .profile.id == "main" and
  .profile.commit == "0791ac0810c65fca3ca0517b9fbbbfe5023d0355"
' "${fixture}/worlds/main/.spawnpoint-world.json" >/dev/null

repeat_output="$("${scripts}/prepare-world.sh" main)"
grep -Fxq 'result=already_prepared' <<<"${repeat_output}"

"${scripts}/prepare-world.sh" vanilla >/dev/null
[[ "$(realpath "${fixture}/worlds/main")" != "$(realpath "${fixture}/worlds/vanilla")" ]]

jq '.profile.id = "vanilla-forge"' \
  "${fixture}/worlds/main/.spawnpoint-world.json" >"${fixture}/tampered-marker.json"
mv -- "${fixture}/tampered-marker.json" "${fixture}/worlds/main/.spawnpoint-world.json"
expect_failure "mismatched marker" "${scripts}/prepare-world.sh" main

printf 'result=passed\n'
