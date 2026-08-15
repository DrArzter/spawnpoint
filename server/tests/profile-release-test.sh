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

printf 'result=passed\n'
