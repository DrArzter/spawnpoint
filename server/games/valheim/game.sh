#!/usr/bin/env bash

# Valheim: the first game written from a Pterodactyl egg used as a reference
# (ADR-0074), and the first whose player count comes over A2S (ADR-0075).
# The dedicated server is Steam app 896660, which installs with an anonymous
# login. It has no remote console: its admin commands run in a player's game.
#
# shellcheck shell=bash
# shellcheck disable=SC2034  # the GAME_* constants are the module's interface, read by _dispatch.sh consumers

GAME_COMPOSE_FILES="games/valheim/compose.yaml"
GAME_FOOTPRINT_COMPOSE_FILE="games/valheim/compose.footprint.yaml"
GAME_COMPOSE_SERVICE="valheim"
# The port a player types after the address the connectivity strategy publishes.
GAME_CONNECT_PORT="2456"
GAME_CONNECT_PROTOCOL="udp"
# Valheim has no RCON. Its Steam query port, always the game port plus one, is
# the probe port, so the host side stays the game port plus one in every slot.
# It is bound to localhost.
GAME_PROBE_PORT="2457"
# The client connects to the port the address names, and the query port keeps
# its offset in every slot. The server names no other port.
GAME_SLOTTABLE="true"
# Fail closed: a server password is one shared secret, not an identity, and
# this configuration verifies no player. A world declares anything stronger
# (ADR-0033, and server/games/README.md).
GAME_DEFAULT_AUTH="none"
# What a session is placed with and limited to (ADR-0054). Documented by the
# image and the egg catalogue, not yet measured here.
GAME_FOOTPRINT_MEMORY_MIB="4096"
GAME_FOOTPRINT_CORES="1"

VALHEIM_GAME_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
VALHEIM_QUERY_HOST="${VALHEIM_QUERY_HOST:-127.0.0.1}"
# The save's name. compose.yaml pins WORLD_NAME to it; a world's id names its
# backups, never this.
VALHEIM_WORLD_NAME="spawnpoint"

# shellcheck source=../_probes/a2s.sh
source "${VALHEIM_GAME_DIR}/../_probes/a2s.sh"

# The host side of the query port follows the slot (ADR-0054), read when the
# probe runs: the slot's ports are exported after the module loads.
valheim_query_port() {
  printf '%s' "${VALHEIM_QUERY_PORT:-${SPAWNPOINT_PROBE_PORT:-2457}}"
  return 0
}

game_query_players_raw() {
  a2s_query_players "${VALHEIM_QUERY_HOST}" "$(valheim_query_port)"
  return $?
}

game_parse_player_count() {
  a2s_parse_player_count
}

# game_console is not defined: the server takes no command from outside the
# game, and console.sh answers that with its own "has no console".

game_tick_time_ms() {
  printf 'error: Valheim reports no tick time over A2S\n' >&2
  return 2
}

game_save() {
  # The image owns the safe-save protocol: on SIGTERM it sends SIGINT to the
  # server, which writes the world and exits. `stop.sh` performs that graceful
  # Compose stop immediately after this hook returns, before the archive.
  printf 'save_deferred=graceful_shutdown\n'
  return 0
}

# A Valheim world is two files in worlds_local: <name>.fwl holds its name and
# seed, <name>.db everything built on it. The server keeps a .old copy of each.
# Its admin, ban and permitted lists sit beside them and belong to the world.
game_save_paths() {
  local data_dir="$1" _world_name="$2"
  local candidate
  for candidate in worlds_local adminlist.txt bannedlist.txt permittedlist.txt; do
    [[ -e "${data_dir}/${candidate}" ]] || continue
    printf '%s\0' "${candidate}"
  done
}

# Both files, because either alone restores a different world: the seed
# without the buildings, or the buildings on a new seed.
game_save_sentinel() {
  local data_dir="$1" _world_name="$2"
  [[ -s "${data_dir}/worlds_local/${VALHEIM_WORLD_NAME}.fwl" && -s "${data_dir}/worlds_local/${VALHEIM_WORLD_NAME}.db" ]]
}

game_archive_sentinel_regex() {
  local _world_name="$1"
  printf '^worlds_local/%s\\.db$' "${VALHEIM_WORLD_NAME}"
}
