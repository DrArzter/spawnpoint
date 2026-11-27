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

GAME_COMPOSE_FILES="games/zomboid/compose.yaml"
GAME_FOOTPRINT_COMPOSE_FILE="games/zomboid/compose.footprint.yaml"
GAME_COMPOSE_SERVICE="zomboid"
# start_timeout_seconds in game.json is 1500: a new host downloads the server
# (about four minutes) before the world loads (about five and a half), so the
# default ten minutes ended starts that worked.
# Why the facts in game.json are what they are (ADR-0088):
# - slottable false: the server tells a client to continue on its second port
#   (UDPPort, 16262 by default), which a slot's host mapping would not carry.
#   Rendering DefaultPort and UDPPort into the server's ini from the slot is
#   what lifts this; until then a Zomboid world runs on slot zero only.
# - default_auth none: fail closed. The server verifies Steam identities only
#   in Steam mode with that verification on, and this project has not
#   exercised that configuration. A world whose server does verify declares
#   `auth: game` (ADR-0033, and server/games/README.md).
# - footprint: the image gives the JVM a 6 GiB heap by default (MEMORY_XMX_GB),
#   and the process is larger than its heap.

# The port a player types after the address the connectivity strategy publishes.
  # 16262/udp is opened beside it, but players type only this one.

ZOMBOID_GAME_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ZOMBOID_DATA_DIR="${ZOMBOID_DATA_DIR:-${SPAWNPOINT_WORLD_DATA_DIRECTORY:-${ZOMBOID_GAME_DIR}/data}}"
ZOMBOID_RCON_HOST="${ZOMBOID_RCON_HOST:-127.0.0.1}"

# shellcheck source=../_probes/rcon.sh
source "${ZOMBOID_GAME_DIR}/../_probes/rcon.sh"

# The host side of the RCON mapping follows the slot (ADR-0054), read when a
# command is sent: the slot's ports are exported after the module loads.
zomboid_rcon_port() {
  printf '%s' "${ZOMBOID_RCON_PORT:-${SPAWNPOINT_PROBE_PORT:-27015}}"
  return 0
}
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

# Source RCON, spoken from the host with the shared probe client — the
# protocol is the same, only the commands and their wording differ.
zomboid_rcon() {
  local command="$1" password
  password="$(zomboid_rcon_password)" || {
    printf 'error: ZOMBOID_RCON_PASSWORD is not set in the environment or the runtime .env\n' >&2
    return 1
  }
  rcon_query "${ZOMBOID_RCON_HOST}" "$(zomboid_rcon_port)" "${password}" "${command}"
  return $?
}

game_query_players_raw() {
  zomboid_rcon "players"
  return $?
}

# The reply, or the transport's failure: its status is the caller's answer.
game_console() {
  local command="$1"
  zomboid_rcon "${command}"
  return $?
}

# servermsg takes one quoted argument; a quote inside the text would end it.
game_announce() {
  local apostrophe="'" text
  text="${1//\"/${apostrophe}}"
  zomboid_rcon "servermsg \"${text}\"" >/dev/null
  return $?
}

# Project Zomboid exposes no tick or frame time over RCON; the acceptance
# records it as unmeasured rather than guessing from something else.
game_tick_time_ms() {
  printf 'error: Project Zomboid reports no tick time over RCON\n' >&2
  return 2
}

# The image writes the RCON password into the server's ini only when that file
# exists, and the server creates it with RCON off on a world's first start. So
# the probe never got an answer and the stop could not save. Seeding the keys
# the image patches lets it fill them in; the server adds every other default.
game_prepare_session() {
  # Read now: the world's directory is chosen after this module loads.
  local ini="${SPAWNPOINT_WORLD_DATA_DIRECTORY:-${ZOMBOID_DATA_DIR}}/Server/dedicated.ini"
  [[ -f "${ini}" ]] && return 0
  mkdir -p -- "$(dirname -- "${ini}")"
  printf '%s=\n' PVP MaxPlayers RCONPassword RCONPort Password Public DefaultPort UDPPort >"${ini}"
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
