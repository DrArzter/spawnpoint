#!/usr/bin/env bash

# The minecraft module is the extracted original behaviour, verbatim: the
# default game must be indistinguishable from the pre-adapter scripts, because
# the deployed workflows invoke those scripts with no game named.
#
# shellcheck shell=bash
# shellcheck disable=SC2034  # the GAME_* constants are the module's interface, read by _dispatch.sh consumers

GAME_COMPOSE_FILES="compose.yaml:compose.release.yaml"
GAME_COMPOSE_SERVICE="mc"
GAME_MOD_EXTENSION="jar"
GAME_LOADER_TYPE="forge"

game_query_players_raw() {
  rcon list
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
