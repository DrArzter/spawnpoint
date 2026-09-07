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

main_output="$("${scripts}/world-profile.sh" world)"
grep -Fxq 'world_id=world' <<<"${main_output}"
grep -Fxq 'profile_id=main' <<<"${main_output}"
grep -Fxq 'profile_commit=0791ac0810c65fca3ca0517b9fbbbfe5023d0355' <<<"${main_output}"

vanilla_output="$("${scripts}/world-profile.sh" vanilla)"
grep -Fxq 'profile_id=vanilla-forge' <<<"${vanilla_output}"
expect_failure "unknown world" "${scripts}/world-profile.sh" missing
expect_failure "invalid world id" "${scripts}/world-profile.sh" '../main'

# A registry record adds one generation-backed world without changing the
# deployed static catalog or redirecting any legacy world's data directory.
mkdir -p -- "${fixture}/bin" "${fixture}/s3/releases/worlds/minecraft-creative"
ln -s -- "${repository_root}/server/tests/fake-aws" "${fixture}/bin/aws"
cat >"${fixture}/s3/releases/worlds/minecraft-creative/world.json" <<'EOF'
{"schema_version":1,"world_id":"minecraft-creative","game":"minecraft","display_name":"Creative","status":"active","connectivity":"zerotier","storage_layout":"generation","preset":{"id":"creative","repository":"https://github.com/DrArzter/config","commit":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","profile_digest":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"},"current_generation":{"id":"gen-123456781234123412341234567890ab","release":"42.7","created_at":"2026-09-07T18:00:00.000Z"}}
EOF
dynamic_output="$(
  PATH="${fixture}/bin:${PATH}" \
  FAKE_S3_ROOT="${fixture}/s3" \
  RELEASE_BUCKET=releases \
  SPAWNPOINT_RUNTIME_DIRECTORY="${fixture}/runtime" \
    "${scripts}/refresh-world-catalog.sh" minecraft-creative
)"
dynamic_catalog="$(awk -F= '$1 == "catalog" { print substr($0, index($0, "=") + 1) }' <<<"${dynamic_output}")"
dynamic_profile="$(SPAWNPOINT_WORLD_CATALOG="${dynamic_catalog}" "${scripts}/world-profile.sh" minecraft-creative)"
grep -Fxq 'profile_id=creative' <<<"${dynamic_profile}"
grep -Fq '/worlds/minecraft-creative/generations/gen-123456781234123412341234567890ab/data' <<<"${dynamic_profile}"
SPAWNPOINT_WORLD_CATALOG="${dynamic_catalog}" "${scripts}/prepare-world.sh" minecraft-creative >/dev/null
jq -e '.generation == {id: "gen-123456781234123412341234567890ab", release: "42.7"}' \
  "${fixture}/worlds/minecraft-creative/generations/gen-123456781234123412341234567890ab/.spawnpoint-world.json" >/dev/null

prepare_output="$("${scripts}/prepare-world.sh" world)"
grep -Fxq 'result=prepared' <<<"${prepare_output}"
[[ -d "${fixture}/worlds/world/data" ]]
[[ -d "${fixture}/worlds/world/mods" ]]
jq -e '
  .world_id == "world" and
  .profile.id == "main" and
  .profile.commit == "0791ac0810c65fca3ca0517b9fbbbfe5023d0355"
' "${fixture}/worlds/world/.spawnpoint-world.json" >/dev/null

repeat_output="$("${scripts}/prepare-world.sh" world)"
grep -Fxq 'result=already_prepared' <<<"${repeat_output}"

"${scripts}/prepare-world.sh" vanilla >/dev/null
[[ "$(realpath "${fixture}/worlds/world")" != "$(realpath "${fixture}/worlds/vanilla")" ]]

jq '.profile.id = "vanilla-forge"' \
  "${fixture}/worlds/world/.spawnpoint-world.json" >"${fixture}/tampered-marker.json"
mv -- "${fixture}/tampered-marker.json" "${fixture}/worlds/world/.spawnpoint-world.json"
expect_failure "mismatched marker" "${scripts}/prepare-world.sh" world

# --- provenance is per world when it needs to be: one authoring repository per
#     game, and a pin bump for one world must not invalidate another's marker ---
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
