#!/usr/bin/env bash

set -Eeuo pipefail

repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
scripts="${repository_root}/server/scripts"
fixture="$(mktemp -d /tmp/spawnpoint-profile-release-test.XXXXXXXX)"
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

config_repo="${fixture}/config"
mkdir -p -- "${config_repo}/profiles/main/extras" "${config_repo}/profiles/vanilla-forge"
git -C "${config_repo}" init --quiet
git -C "${config_repo}" remote add origin https://github.com/example/minecraft-config.git

cat >"${config_repo}/profiles/main/profile.json" <<'EOF'
{"schema_version":1,"id":"main","minecraft_version":"1.20.1","loader":{"type":"forge","version":"47.4.10"},"mods":{"source":"extras/cf-mods.txt"}}
EOF
printf 'https://example.invalid/mod\n' >"${config_repo}/profiles/main/extras/cf-mods.txt"
cat >"${config_repo}/profiles/vanilla-forge/profile.json" <<'EOF'
{"schema_version":1,"id":"vanilla-forge","minecraft_version":"1.20.1","loader":{"type":"forge","version":"47.4.10"},"mods":{"source":null}}
EOF
git -C "${config_repo}" add profiles
git -C "${config_repo}" \
  -c user.name=Spawnpoint-Test \
  -c user.email=spawnpoint@example.invalid \
  commit --quiet -m 'test profiles'
profile_commit="$(git -C "${config_repo}" rev-parse HEAD)"

mkdir -p -- "${fixture}/main-mods" "${fixture}/vanilla-mods" "${fixture}/runtime/mods"
printf 'mod bytes\n' >"${fixture}/main-mods/example.jar"
printf 'stale bytes\n' >"${fixture}/runtime/mods/stale.jar"

main_manifest="${fixture}/main-manifest.json"
"${scripts}/build-profile-release.sh" \
  "${config_repo}/profiles/main" 1.0 "${fixture}/main-mods" "${main_manifest}" >/dev/null
jq -e \
  --arg commit "${profile_commit}" '
    .source_profile == {
      id: "main",
      repository: "https://github.com/example/minecraft-config.git",
      commit: $commit
    }
    and (.server.mods | length) == 1
  ' "${main_manifest}" >/dev/null

vanilla_manifest="${fixture}/vanilla-manifest.json"
output="$(
  "${scripts}/build-profile-release.sh" \
    "${config_repo}/profiles/vanilla-forge" 1.0 "${fixture}/vanilla-mods" "${vanilla_manifest}"
)"
grep -Fxq 'mods=0' <<<"${output}"
jq -e '.source_profile.id == "vanilla-forge" and .server.mods == []' \
  "${vanilla_manifest}" >/dev/null

mkdir -p -- "${fixture}/vanilla-release/mods"
cp -- "${vanilla_manifest}" "${fixture}/vanilla-release/manifest.json"
RELEASE_SOURCE_DIR="${fixture}/vanilla-release" \
  "${scripts}/reconcile-release.sh" \
    "${fixture}/vanilla-release/manifest.json" "${fixture}/runtime/mods" >/dev/null
[[ ! -e "${fixture}/runtime/mods/stale.jar" ]]
[[ -f "${fixture}/runtime/mods/.spawnpoint-release.json" ]]
[[ "$(find "${fixture}/runtime/mods" -maxdepth 1 -type f -name '*.jar' | wc -l)" == 0 ]]

printf 'dirty\n' >>"${config_repo}/profiles/main/extras/cf-mods.txt"
expect_failure "dirty source profile" \
  "${scripts}/build-profile-release.sh" \
    "${config_repo}/profiles/main" 1.1 "${fixture}/main-mods" "${fixture}/dirty.json"

expect_failure "empty-mod profile with resolved JARs" \
  "${scripts}/build-profile-release.sh" \
    "${config_repo}/profiles/vanilla-forge" 1.1 "${fixture}/main-mods" "${fixture}/wrong.json"

# --- the game axis: a factorio profile from its own repository (ADR-0034) ---
factorio_repo="${fixture}/factorio-config"
mkdir -p -- "${factorio_repo}/profiles/factorio-modded/extras" "${fixture}/factorio-mods"
git -C "${factorio_repo}" init --quiet
git -C "${factorio_repo}" remote add origin https://github.com/example/factorio-config.git
cat >"${factorio_repo}/profiles/factorio-modded/profile.json" <<'EOF'
{"schema_version":1,"game":"factorio","id":"factorio-modded","factorio_version":"2.0.77","loader":{"type":"factorio","version":null},"mods":{"source":"extras/mod-pins.txt"}}
EOF
printf 'graftorio2:0.4.20\n' >"${factorio_repo}/profiles/factorio-modded/extras/mod-pins.txt"
git -C "${factorio_repo}" add profiles
git -C "${factorio_repo}" \
  -c user.name=Spawnpoint-Test \
  -c user.email=spawnpoint@example.invalid \
  commit --quiet -m 'factorio profile'
factorio_commit="$(git -C "${factorio_repo}" rev-parse HEAD)"

printf 'zip bytes\n' >"${fixture}/factorio-mods/graftorio2_0.4.20.zip"
printf 'a jar has no business in a factorio release\n' >"${fixture}/factorio-mods/stray.jar"
factorio_manifest="${fixture}/factorio-manifest.json"
factorio_output="$(
  "${scripts}/build-profile-release.sh" \
    "${factorio_repo}/profiles/factorio-modded" 2.0 "${fixture}/factorio-mods" "${factorio_manifest}"
)"
grep -Fxq 'game=factorio' <<<"${factorio_output}"
grep -Fxq 'mods=1' <<<"${factorio_output}"
jq -e \
  --arg commit "${factorio_commit}" '
    .game == "factorio"
    and .minecraft_version == "2.0.77"
    and .loader == {type: "factorio", version: "2.0.77"}
    and .source_profile == {
      id: "factorio-modded",
      repository: "https://github.com/example/factorio-config.git",
      commit: $commit
    }
    and (.server.mods | length) == 1
    and .server.mods[0].file == "graftorio2_0.4.20.zip"
  ' "${factorio_manifest}" >/dev/null

# A vanilla Zomboid preset is a first-class empty immutable release. Workshop
# resolution is not implied by this path and will get its own resolver tests.
zomboid_repo="${fixture}/zomboid-config"
mkdir -p -- "${zomboid_repo}/profiles/zomboid-vanilla" "${fixture}/zomboid-mods"
git -C "${zomboid_repo}" init --quiet
git -C "${zomboid_repo}" remote add origin https://github.com/example/zomboid-config.git
cat >"${zomboid_repo}/profiles/zomboid-vanilla/profile.json" <<'EOF'
{"schema_version":1,"game":"zomboid","id":"zomboid-vanilla","zomboid_build":"42.20","loader":{"type":"workshop","version":null},"mods":{"source":null}}
EOF
git -C "${zomboid_repo}" add profiles
git -C "${zomboid_repo}" -c user.name=Spawnpoint-Test -c user.email=spawnpoint@example.invalid commit --quiet -m 'zomboid profile'
zomboid_manifest="${fixture}/zomboid-manifest.json"
zomboid_output="$(
  "${scripts}/build-profile-release.sh" \
    "${zomboid_repo}/profiles/zomboid-vanilla" 3.0 "${fixture}/zomboid-mods" "${zomboid_manifest}"
)"
grep -Fxq 'game=zomboid' <<<"${zomboid_output}"
grep -Fxq 'mods=0' <<<"${zomboid_output}"
jq -e '
  .game == "zomboid"
  and .minecraft_version == "42.20"
  and .loader == {type: "workshop", version: "42.20"}
  and .source_profile.id == "zomboid-vanilla"
  and .server.mods == []
' "${zomboid_manifest}" >/dev/null

# a minecraft-shaped profile that claims factorio is refused by the game's own
# loader contract rather than passing through with the wrong vocabulary
mkdir -p -- "${config_repo}/profiles/mislabelled"
cat >"${config_repo}/profiles/mislabelled/profile.json" <<'EOF'
{"schema_version":1,"game":"factorio","id":"mislabelled","minecraft_version":"1.20.1","loader":{"type":"forge","version":"47.4.10"},"mods":{"source":null}}
EOF
git -C "${config_repo}" add profiles
git -C "${config_repo}" \
  -c user.name=Spawnpoint-Test \
  -c user.email=spawnpoint@example.invalid \
  commit --quiet -m 'mislabelled profile'
expect_failure "a profile whose game and loader disagree" \
  "${scripts}/build-profile-release.sh" \
    "${config_repo}/profiles/mislabelled" 2.1 "${fixture}/vanilla-mods" "${fixture}/mislabelled.json"

mkdir -p -- "${config_repo}/profiles/unknown-game"
cat >"${config_repo}/profiles/unknown-game/profile.json" <<'EOF'
{"schema_version":1,"game":"quake","id":"unknown-game","minecraft_version":"1.0","loader":{"type":"forge","version":"1"},"mods":{"source":null}}
EOF
git -C "${config_repo}" add profiles
git -C "${config_repo}" \
  -c user.name=Spawnpoint-Test \
  -c user.email=spawnpoint@example.invalid \
  commit --quiet -m 'unknown game'
expect_failure "a profile naming a game with no contract" \
  "${scripts}/build-profile-release.sh" \
    "${config_repo}/profiles/unknown-game" 2.2 "${fixture}/vanilla-mods" "${fixture}/unknown.json"

printf 'result=passed\n'
