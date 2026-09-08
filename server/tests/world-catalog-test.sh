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

# A restore generation carries only a checksum-addressed backup reference in
# the registry. First preparation downloads, verifies and expands it into the
# new generation; it never writes over the old directory.
restore_checksum="$(printf 'restored level\n' | sha256sum | awk '{print $1}')"
restore_source="gen-123456781234123412341234567890ab"
restore_generation="gen-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
mkdir -p -- "${fixture}/restore-source/minecraft-creative" "${fixture}/s3/backups/worlds/minecraft-creative/archives"
printf 'restored level\n' >"${fixture}/restore-source/minecraft-creative/level.dat"
restore_archive="${fixture}/s3/backups/worlds/minecraft-creative/archives/minecraft-creative-${restore_source}-20260908T100000Z-placeholder.tar.zst"
tar --create --zstd --file "${restore_archive}" --directory "${fixture}/restore-source" minecraft-creative
restore_checksum="$(sha256sum "${restore_archive}" | awk '{print $1}')"
restore_base64="$(openssl dgst -sha256 -binary "${restore_archive}" | base64 | tr -d '\n')"
restore_key="worlds/minecraft-creative/archives/minecraft-creative-${restore_source}-20260908T100000Z-${restore_checksum}.tar.zst"
mv -- "${restore_archive}" "${fixture}/s3/backups/${restore_key}"
printf 'sha256=%s,world=minecraft-creative\n%s\n' "${restore_checksum}" "${restore_base64}" \
  >"${fixture}/s3/backups/${restore_key}.fake-metadata"
jq --arg generation "${restore_generation}" --arg key "${restore_key}" --arg checksum "${restore_checksum}" '
  .current_generation = {
    id: $generation, release: "42.7", created_at: "2026-09-08T10:00:00.000Z",
    source: {kind: "backup", key: $key, checksum: $checksum, generation_id: "gen-123456781234123412341234567890ab"}
  }
' "${fixture}/s3/releases/worlds/minecraft-creative/world.json" >"${fixture}/restored-world.json"
mv -- "${fixture}/restored-world.json" "${fixture}/s3/releases/worlds/minecraft-creative/world.json"
PATH="${fixture}/bin:${PATH}" FAKE_S3_ROOT="${fixture}/s3" RELEASE_BUCKET=releases \
  SPAWNPOINT_RUNTIME_DIRECTORY="${fixture}/runtime-restored" \
  "${scripts}/refresh-world-catalog.sh" minecraft-creative >/dev/null
PATH="${fixture}/bin:${PATH}" FAKE_S3_ROOT="${fixture}/s3" BACKUP_BUCKET=backups \
  SPAWNPOINT_WORLD_CATALOG="${fixture}/runtime-restored/world-catalog.json" \
  "${scripts}/prepare-world.sh" minecraft-creative >/dev/null
grep -Fxq 'restored level' \
  "${fixture}/worlds/minecraft-creative/generations/${restore_generation}/data/minecraft-creative/level.dat"
jq -e --arg key "${restore_key}" '.restore.backup_key == $key' \
  "${fixture}/worlds/minecraft-creative/generations/${restore_generation}/.spawnpoint-world.json" >/dev/null

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
