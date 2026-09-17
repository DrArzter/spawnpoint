#!/usr/bin/env bash

# The minecraft module is the extracted original behaviour, verbatim: the
# default game must be indistinguishable from the pre-adapter scripts, because
# the deployed workflows invoke those scripts with no game named.
#
# shellcheck shell=bash
# shellcheck disable=SC2034  # the GAME_* constants are the module's interface, read by _dispatch.sh consumers

GAME_COMPOSE_FILES="compose.yaml:compose.release.yaml"
GAME_OBSERVABILITY_COMPOSE_FILES="compose.minecraft-observability.yaml"
GAME_HOST_OBSERVABILITY_COMPOSE_FILE="compose.minecraft-host-observability.yaml"
GAME_FOOTPRINT_COMPOSE_FILE="games/minecraft/compose.footprint.yaml"
GAME_COMPOSE_SERVICE="mc"
GAME_MOD_EXTENSION="jar"
GAME_LOADER_TYPE="forge"
# The port a player types after the address the connectivity strategy publishes.
GAME_CONNECT_PORT="25565"
GAME_CONNECT_PROTOCOL="tcp"
# RCON is spoken inside the container (rcon-cli), so no host port is published;
# the constant names the window layout all the same.
GAME_RCON_PORT="25575"
# The client connects to whatever port the address names and the server
# announces none, so a slot's host port forwards cleanly.
GAME_SLOTTABLE="true"
# online-mode=false (ADR-0022) authenticates nobody, so minecraft worlds need
# a gating connectivity unless the catalog declares auth handled (ADR-0033).
GAME_DEFAULT_AUTH="none"
# What a session is placed with and limited to (ADR-0054): a 4 GiB heap was
# measured near 6 GiB of container memory, and the limit sits above the peak,
# not on it. The container, not the JVM, is what the host counts.
GAME_FOOTPRINT_MEMORY_MIB="7168"
GAME_FOOTPRINT_CORES="1"

game_query_players_raw() {
  rcon list
}

game_save() {
  local save_result
  rcon save-off >/dev/null
  if ! save_result="$(rcon save-all flush)"; then
    rcon save-on >/dev/null || printf 'warning: failed to re-enable Minecraft autosave\n' >&2
    return 1
  fi
  rcon save-on >/dev/null || printf 'warning: failed to re-enable Minecraft autosave\n' >&2
  printf '%s\n' "${save_result}"
}

# Readiness, extracted verbatim from start.sh: the pinned image carries a Docker
# health check, and where one exists both it and a working control path are
# required.
game_ready() {
  local health="$1"
  [[ "${health}" == "healthy" || "${health}" == "none" ]] && rcon list >/dev/null 2>&1
}

game_parse_player_count() {
  local response count
  response="$(cat)"
  count="$(sed -nE 's/^There are ([0-9]+) of a max of [0-9]+ players online.*$/\1/p' <<<"${response}")"
  [[ "${count}" =~ ^[0-9]+$ ]] || return 1
  printf '%s\n' "${count}"
}

# The world and its dimension siblings (world_nether, ...), exactly as before.
game_save_paths() {
  local data_dir="$1" world_name="$2"
  find "${data_dir}" -mindepth 1 -maxdepth 1 -type d -name "${world_name}*" -printf '%f\0' | sort -z
}

game_save_sentinel() {
  local data_dir="$1" world_name="$2"
  [[ -f "${data_dir}/${world_name}/level.dat" ]]
}

# What a verified archive must contain to count as a save of this game.
game_archive_sentinel_regex() {
  local world_name="$1"
  printf '^%s/level\\.dat$' "${world_name}"
}
