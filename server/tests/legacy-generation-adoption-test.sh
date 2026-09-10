#!/usr/bin/env bash

set -Eeuo pipefail

repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
fixture="$(mktemp -d /tmp/spawnpoint-legacy-generation-adoption-test.XXXXXXXX)"
cleanup() { rm -rf -- "${fixture}"; }
trap cleanup EXIT

mkdir -p -- "${fixture}/legacy-data/world" "${fixture}/legacy-mods" "${fixture}/worlds"
printf 'level\n' >"${fixture}/legacy-data/world/level.dat"
printf 'mod\n' >"${fixture}/legacy-mods/example.jar"
jq -n '{
  schema_version: 1,
  profile_source: {repository: "https://github.com/example/config", commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},
  worlds: [{
    id: "world", display_name: "World", profile_id: "main", game: "minecraft",
    connectivity: "zerotier", storage_layout: "generation",
    generation_id: "gen-123456781234123412341234567890ab", release: "1.1"
  }]
}' >"${fixture}/catalog.json"

run_adoption() {
  SPAWNPOINT_WORLD_CATALOG="${fixture}/catalog.json" \
  SPAWNPOINT_WORLDS_DIRECTORY="${fixture}/worlds" \
    "${repository_root}/server/scripts/adopt-legacy-world-generation.sh" world \
      "${fixture}/legacy-data" "${fixture}/legacy-mods"
}

first="$(run_adoption)"
grep -Fxq 'result=adopted' <<<"${first}"
target="${fixture}/worlds/world/generations/gen-123456781234123412341234567890ab"
grep -Fxq 'level' "${target}/data/world/level.dat"
grep -Fxq 'mod' "${target}/mods/example.jar"
jq -e '.source.kind == "legacy_runtime"' "${target}/.spawnpoint-legacy-adoption.json" >/dev/null

second="$(run_adoption)"
grep -Fxq 'result=already_adopted' <<<"${second}"
printf 'changed\n' >"${target}/data/world/level.dat"
if run_adoption >/dev/null 2>&1; then
  printf 'expected changed destination to be refused\n' >&2
  exit 1
fi

grep -Fxq 'level' "${fixture}/legacy-data/world/level.dat"
printf 'legacy-generation-adoption-test: ok\n'
