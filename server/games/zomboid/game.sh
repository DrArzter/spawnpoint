#!/usr/bin/env bash

# Project Zomboid: the group favourite, and the game that bends the release
# model rather than the adapter. Two facts decided this module's shape, both
# checked 2026-08-27:
#
#   * The dedicated server is a separate Steam app (380870) that installs with
#     an anonymous login, and it downloads the Workshop items listed in its own
#     configuration at startup. So neither the server nor this project needs a
#     Steam account — only the players do, and they own the game.
#   * The Workshop has no versions and no resolvable API, but that does not
#     stop a release from being bytes: the server downloads its own Workshop
#     items, so a cut can capture what landed and pin those files like any
#     other payload. Not built yet — this world is vanilla, and vanilla needs
#     no payload at all. See docs/prior-art.md for the capture shape.
#
# shellcheck shell=bash
# shellcheck disable=SC2034  # the GAME_* constants are the module's interface, read by _dispatch.sh consumers

GAME_COMPOSE_FILES="observability/compose.yaml:games/zomboid/compose.yaml"
GAME_COMPOSE_SERVICE="zomboid"
# No release payload exists for this game, so neither value is ever read by the
# release scripts; they are set for the contract and left honest.
GAME_MOD_EXTENSION=""
GAME_LOADER_TYPE="workshop"
# The port a player types after the address the connectivity strategy publishes.
  # 16262/udp is opened beside it, but players type only this one.
GAME_CONNECT_PORT="16261"
GAME_CONNECT_PROTOCOL="udp"
# Fail closed: the server verifies Steam identities only when it runs in Steam
# mode with that verification on, and this project has not exercised that
# configuration. A world whose server does verify declares `auth: game`
# (ADR-0033, and server/games/README.md).
GAME_DEFAULT_AUTH="none"
# What a session is placed with and limited to (ADR-0054): the image gives
# the JVM a 6 GiB heap by default (MEMORY_XMX_GB), and the process is larger
# than its heap.
GAME_FOOTPRINT_MEMORY_MIB="8192"
GAME_FOOTPRINT_CORES="1"

ZOMBOID_GAME_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ZOMBOID_DATA_DIR="${ZOMBOID_DATA_DIR:-${SPAWNPOINT_WORLD_DATA_DIRECTORY:-${ZOMBOID_GAME_DIR}/data}}"
ZOMBOID_RCON_HOST="${ZOMBOID_RCON_HOST:-127.0.0.1}"
ZOMBOID_RCON_PORT="${ZOMBOID_RCON_PORT:-27015}"
# Unlike factorio, this server does not generate its own password: the image
# takes RCON_PASSWORD from the environment, so the host's runtime environment is
# where the probe finds it too. Reading a file the image never writes was a
# copied assumption, and it would have failed every probe.
zomboid_rcon_password() {
  if [[ -n "${ZOMBOID_RCON_PASSWORD:-}" ]]; then
    printf '%s' "${ZOMBOID_RCON_PASSWORD}"
    return 0
  fi
  local env_file="${SERVER_ENV_FILE:-${ZOMBOID_GAME_DIR}/../../.env}"
  [[ -f "${env_file}" ]] || return 1
  awk -F= '$1 == "ZOMBOID_RCON_PASSWORD" { print substr($0, index($0, "=") + 1); found = 1; exit }
    END { if (!found) exit 1 }' "${env_file}"
}

# Source RCON, spoken from the host with the factorio module's client — the
# protocol is the same, only the commands and their wording differ.
game_query_players_raw() {
  local password
  password="$(zomboid_rcon_password)" || {
    printf 'error: ZOMBOID_RCON_PASSWORD is not set in the environment or the runtime .env\n' >&2
    return 1
  }
  python3 "${ZOMBOID_GAME_DIR}/../factorio/rcon-client.py" \
    "${ZOMBOID_RCON_HOST}" "${ZOMBOID_RCON_PORT}" \
    "${password}" \
    "players"
}

game_save() {
  # This image owns the safe-save protocol: on SIGTERM it sends `save`, then
  # `quit`, and waits for the server. `stop.sh` performs that graceful Compose
  # stop immediately after this hook returns, before the archive is created.
  printf 'save_deferred=graceful_shutdown\n'
  return 0
}

# "Players connected (N):" followed by one "-name" line per player.
#
# The exact wording is not documented anywhere authoritative, so the parser
# does not trust it alone: it reads the count from the header AND counts the
# listed names, and refuses unless they agree. A wrong guess therefore reports
# "unreadable" — which the probe treats as "not idle" and the stop treats as a
# refusal — rather than reporting an empty server that is not empty.
game_parse_player_count() {
  local response header_count listed
  response="$(cat)"
  header_count="$(sed -nE 's/^[[:space:]]*Players connected \(([0-9]+)\).*$/\1/p' <<<"${response}" | head -n1)"
  [[ "${header_count}" =~ ^[0-9]+$ ]] || return 1
  listed="$(grep -cE '^[[:space:]]*-' <<<"${response}" || true)"
  [[ "${listed}" == "${header_count}" ]] || return 1
  printf '%s\n' "${header_count}"
}

game_ready() {
  local health="$1"
  [[ "${health}" != "unhealthy" ]] || return 1
  game_query_players_raw 2>/dev/null | game_parse_player_count >/dev/null 2>&1
}

# A Zomboid world lives in two places under the data directory: the world
# itself (map chunks, plus the player and vehicle databases inside it) and the
# accounts database beside it. Archiving one without the other restores a world
# whose players do not exist, or players with no world.
game_save_paths() {
  local data_dir="$1" _world_name="$2"
  local candidate
  for candidate in Saves db; do
    [[ -d "${data_dir}/${candidate}" ]] || continue
    printf '%s\0' "${candidate}"
  done
}

# The image documents no variable for the server name, and the name decides both
# the save directory and the accounts database file. So neither is assumed: a
# save is whatever single world lives under Saves/Multiplayer, and the archive
# is judged the same way. Restoring recreates whatever name was archived.
game_save_sentinel() {
  local data_dir="$1" _world_name="$2"
  [[ -n "$(find "${data_dir}/Saves/Multiplayer" -mindepth 2 -maxdepth 2 -type f -name 'map_*.bin' -print -quit 2>/dev/null)" ]]
}

game_archive_sentinel_regex() {
  local _world_name="$1"
  printf '^Saves/Multiplayer/[^/]+/map_[^/]*\\.bin$'
}
