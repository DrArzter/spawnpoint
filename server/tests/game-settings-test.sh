#!/usr/bin/env bash

# A world's game settings (ADR-0064): the registry records them, the host
# projects them into its catalog, and every lifecycle command exports the ones
# the world sets, under the names the game's settings.json gives them.

set -Eeuo pipefail

repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
scripts="${repository_root}/server/scripts"
games="${repository_root}/server/games"
fixture="$(mktemp -d /tmp/spawnpoint-game-settings-test.XXXXXXXX)"
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

world_id="minecraft-rostik-1a2b3c4d"
mkdir -p -- "${fixture}/bin" "${fixture}/s3/releases/worlds/${world_id}"
ln -s -- "${repository_root}/server/tests/fake-aws" "${fixture}/bin/aws"
export SPAWNPOINT_WORLDS_DIRECTORY="${fixture}/worlds"

# The world record as the access API writes it, with these values or none.
write_record() {
  local game="$1" values="$2"
  jq -n --arg id "${world_id}" --arg game "${game}" --argjson values "${values}" '{
    schema_version: 1, world_id: $id, game: $game, display_name: "Rostik", status: "active",
    connectivity: "zerotier", storage_layout: "generation",
    preset: {id: "industrial", repository: "https://github.com/DrArzter/config",
      commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      profile_digest: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"},
    current_generation: {id: "gen-123456781234123412341234567890ab", release: "1.2", created_at: "2026-10-09T10:00:00.000Z"}
  } + (if $values == null then {} else {game_settings: {
    values: $values, updated_at: "2026-10-09T11:00:00.000Z",
    updated_by: {identity_id: "identity-owner", display_name: "DrArzter"}
  }} end)' >"${fixture}/s3/releases/worlds/${world_id}/world.json"
}

# The host's catalog, refreshed from the record as start-session.sh does.
project() {
  local output
  output="$(
    PATH="${fixture}/bin:${PATH}" FAKE_S3_ROOT="${fixture}/s3" RELEASE_BUCKET=releases \
      SPAWNPOINT_RUNTIME_DIRECTORY="${fixture}/runtime" \
      "${scripts}/refresh-world-catalog.sh" "${world_id}"
  )" || return 1
  awk -F= '$1 == "catalog" { print substr($0, index($0, "=") + 1) }' <<<"${output}"
}

# What one lifecycle command exports for compose. "unset" marks a variable the
# command leaves alone, which compose then keeps out of the container.
names=(DIFFICULTY MODE MAX_PLAYERS MOTD PVP ALLOW_FLIGHT SPAWN_MONSTERS VIEW_DISTANCE SIMULATION_DISTANCE)
exported() {
  local catalog="$1"
  env -u DIFFICULTY -u MODE -u MAX_PLAYERS -u MOTD -u PVP -u ALLOW_FLIGHT -u SPAWN_MONSTERS -u VIEW_DISTANCE -u SIMULATION_DISTANCE \
    WORLD_ID="${world_id}" SPAWNPOINT_WORLD_CATALOG="${catalog}" \
    bash -c '
      source "$1/_dispatch.sh"
      resolve_game
      configure_game_compose
      shift
      for name in "$@"; do printf "%s=%s\n" "${name}" "${!name-unset}"; done
    ' _ "${games}" "${names[@]}"
}

# --- the values the world sets are exported, and nothing else ---
write_record minecraft '{"difficulty": "hard", "max_players": 8, "motd": "Rostik'"'"'s world: no griefing!", "pvp": false, "allow_flight": true}'
catalog="$(project)"
jq -e --arg id "${world_id}" '.worlds[] | select(.id == $id) | .game_settings.max_players == 8' "${catalog}" >/dev/null
output="$(exported "${catalog}")"
grep -Fxq 'DIFFICULTY=hard' <<<"${output}"
grep -Fxq 'MAX_PLAYERS=8' <<<"${output}"
grep -Fxq "MOTD=Rostik's world: no griefing!" <<<"${output}"
grep -Fxq 'PVP=false' <<<"${output}"
grep -Fxq 'ALLOW_FLIGHT=true' <<<"${output}"
grep -Fxq 'MODE=unset' <<<"${output}"
grep -Fxq 'VIEW_DISTANCE=unset' <<<"${output}"

# --- a world that sets nothing exports nothing: its server keeps what it had ---
write_record minecraft null
catalog="$(project)"
jq -e --arg id "${world_id}" '.worlds[] | select(.id == $id) | has("game_settings") | not' "${catalog}" >/dev/null
output="$(exported "${catalog}")"
[[ "$(grep -c '=unset$' <<<"${output}")" == "${#names[@]}" ]]

# --- a setting this checkout does not define is skipped, and said so ---
write_record minecraft '{"max_players": 4, "hardcore": true}'
catalog="$(project)"
warnings="$(exported "${catalog}" 2>&1 >/dev/null)"
grep -Fq 'hardcore' <<<"${warnings}"
grep -Fxq 'MAX_PLAYERS=4' <<<"$(exported "${catalog}" 2>/dev/null)"

# --- a defined setting with a value outside its definition refuses the command ---
for values in '{"max_players": 500}' '{"max_players": 2.5}' '{"difficulty": "nightmare"}' \
  '{"pvp": "yes"}' '{"motd": ""}' '{"motd": "$(reboot)"}' '{"motd": "two\nlines"}'; do
  write_record minecraft "${values}"
  catalog="$(project)"
  expect_failure "game settings ${values}" exported "${catalog}"
done

# --- the record is the boundary: settings that are not scalars never reach a catalog ---
write_record minecraft '{"max_players": [8]}'
expect_failure "a list as a setting" project

# --- a game without definitions ignores a world's settings, and says so ---
write_record factorio '{"max_players": 8}'
catalog="$(project)"
warnings="$(
  WORLD_ID="${world_id}" SPAWNPOINT_WORLD_CATALOG="${catalog}" \
    bash -c 'source "$1/_dispatch.sh"; resolve_game; configure_game_compose; printf "MAX_PLAYERS=%s\n" "${MAX_PLAYERS-unset}"' _ "${games}" 2>&1
)"
grep -Fq 'factorio defines no game settings' <<<"${warnings}"
grep -Fxq 'MAX_PLAYERS=unset' <<<"${warnings}"

# --- every definition names its kind's fields, and its default fits them ---
for definitions in "${games}"/*/settings.json; do
  jq -e '
    .schema_version == 1 and (.settings | length > 0) and
    ([.settings[].id] | unique | length) == (.settings | length) and
    all(.settings[];
      (.id | test("^[a-z][a-z0-9_]{0,31}$")) and (.label | type == "string" and length > 0) and
      (.env | test("^[A-Z][A-Z0-9_]*$")) and
      (.default as $default |
       if .type == "choice" then any(.choices[]; .value == $default and (.label | length > 0))
       elif .type == "integer" then ($default | type == "number") and $default >= .min and $default <= .max
       elif .type == "boolean" then ($default | type == "boolean")
       elif .type == "text" then .pattern as $pattern |
         ($default | type == "string") and ($default | length) <= .max_length and ($default | test($pattern))
       else false end))
  ' "${definitions}" >/dev/null || {
    printf 'invalid settings definitions: %s\n' "${definitions}" >&2
    exit 1
  }
done

printf 'game settings test passed\n'
