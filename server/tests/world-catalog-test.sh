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

# --- provenance is per world when it needs to be: one authoring repository per
#     game, and a pin bump for one world must not invalidate another's marker ---
real_factorio="$("${scripts}/world-profile.sh" factorio)"
grep -Fxq 'profile_repository=https://github.com/DrArzter/my-docker-factorio-server-config' <<<"${real_factorio}"
grep -Fq 'profile_commit=' <<<"${real_factorio}"
[[ "$(awk -F= '$1 == "profile_commit" { print $2 }' <<<"${real_factorio}")" \
  != "$(awk -F= '$1 == "profile_commit" { print $2 }' <<<"${main_output}")" ]]

override_commit="1111111111111111111111111111111111111111"
write_catalog() {
  jq -n --argjson worlds "$1" '{
    schema_version: 1,
    profile_source: {
      repository: "https://example.invalid/default-profiles",
      commit: "0000000000000000000000000000000000000000"
    },
    worlds: $worlds
  }' >"${fixture}/catalog.json"
}
run_profile() {
  SPAWNPOINT_WORLD_CATALOG="${fixture}/catalog.json" "${scripts}/world-profile.sh" "$1"
}

write_catalog "$(jq -n --arg commit "${override_commit}" '[
  {id: "inherits", display_name: "Inherits", profile_id: "inherits"},
  {id: "overrides", display_name: "Overrides", profile_id: "overrides",
   profile_source: {repository: "https://example.invalid/own-profiles", commit: $commit}}
]')"
inherited="$(run_profile inherits)"
grep -Fxq 'profile_repository=https://example.invalid/default-profiles' <<<"${inherited}"
grep -Fxq 'profile_commit=0000000000000000000000000000000000000000' <<<"${inherited}"
overridden="$(run_profile overrides)"
grep -Fxq 'profile_repository=https://example.invalid/own-profiles' <<<"${overridden}"
grep -Fxq "profile_commit=${override_commit}" <<<"${overridden}"

# the marker a prepared world carries records the world's own provenance
SPAWNPOINT_WORLD_CATALOG="${fixture}/catalog.json" "${scripts}/prepare-world.sh" overrides >/dev/null
jq -e --arg commit "${override_commit}" '
  .profile.repository == "https://example.invalid/own-profiles" and .profile.commit == $commit
' "${fixture}/worlds/overrides/.spawnpoint-world.json" >/dev/null

write_catalog '[{"id": "bad", "display_name": "Bad", "profile_id": "bad",
  "profile_source": {"repository": "https://example.invalid/x", "commit": "not-a-sha"}}]'
expect_failure "a per-world profile_source with a short commit" run_profile bad
write_catalog '[{"id": "bad", "display_name": "Bad", "profile_id": "bad",
  "profile_source": {"commit": "1111111111111111111111111111111111111111"}}]'
expect_failure "a per-world profile_source with no repository" run_profile bad

printf 'result=passed\n'
