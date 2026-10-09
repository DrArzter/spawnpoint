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
# The server's level-name, which compose.yaml pins as LEVEL. The save lives in
# this folder of the world's data directory. The world's name names its
# backups, not this folder: each world has a data directory of its own, and a
# world created from a preset has an id such as minecraft-rostik-1a2b3c4d.
MINECRAFT_LEVEL_NAME="world"

game_query_players_raw() {
  rcon list
}

# The reply, or the transport's failure: its status is the caller's answer.
game_console() {
  local command="$1"
  rcon "${command}"
  return $?
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

# The level and its dimension siblings (world_nether, ...).
game_save_paths() {
  local data_dir="$1" _world_name="$2"
  find "${data_dir}" -mindepth 1 -maxdepth 1 -type d -name "${MINECRAFT_LEVEL_NAME}*" -printf '%f\0' | sort -z
}

game_save_sentinel() {
  local data_dir="$1" _world_name="$2"
  [[ -f "${data_dir}/${MINECRAFT_LEVEL_NAME}/level.dat" ]]
}

# Milliseconds per tick, as Forge reports it over RCON ("Overall: Mean tick
# time: 4.123 ms. Mean TPS: 20.000"). The acceptance of ADR-0054 compares this
# figure for a world alone against the same world beside a neighbour.
game_tick_time_ms() {
  local response tick_ms
  response="$(rcon forge tps)" || return 1
  tick_ms="$(sed -nE 's/^Overall: Mean tick time: ([0-9]+(\.[0-9]+)?) ms.*$/\1/p' <<<"${response}" | head -n1)"
  [[ -n "${tick_ms}" ]] || {
    printf 'error: forge tps did not report a mean tick time: %s\n' "$(tr '\n' ';' <<<"${response}")" >&2
    return 1
  }
  printf '%s\n' "${tick_ms}"
}

# Offline mode (ADR-0022) keys a player by the UUID the server derives from the
# name, Java's UUID.nameUUIDFromBytes("OfflinePlayer:" + name). A whitelist must
# carry that UUID: a lookup by name returns the account's online one, which an
# offline server never sees, and the player is turned away.
minecraft_offline_uuid() {
  local name="$1" hex byte6 byte8
  # MD5 is what the game derives the UUID with; it protects nothing here.
  hex="$(printf 'OfflinePlayer:%s' "${name}" | md5sum | cut -c1-32)" # NOSONAR
  byte6=$(( (16#${hex:12:2} & 0x0f) | 0x30 ))
  byte8=$(( (16#${hex:16:2} & 0x3f) | 0x80 ))
  hex="${hex:0:12}$(printf '%02x' "${byte6}")${hex:14:2}$(printf '%02x' "${byte8}")${hex:18:14}"
  printf '%s-%s-%s-%s-%s\n' "${hex:0:8}" "${hex:8:4}" "${hex:12:4}" "${hex:16:4}" "${hex:20:12}"
  return 0
}

# The whitelist a world's record keeps (ADR-0066), written as whitelist.json in
# its data directory: exactly these names, in place of what was there. The
# image writes the file only when WHITELIST is set, which compose never does.
game_render_whitelist() {
  local data_dir="$1" names_json="$2" entries name
  entries="[]"
  while IFS= read -r name; do
    [[ -n "${name}" ]] || continue
    [[ "${name}" =~ ^[A-Za-z0-9_]{3,16}$ ]] || {
      printf 'error: not a Minecraft name: %s\n' "${name}" >&2
      return 1
    }
    entries="$(jq -c --arg uuid "$(minecraft_offline_uuid "${name}")" --arg name "${name}" '. + [{uuid: $uuid, name: $name}]' <<<"${entries}")"
  done < <(jq -r '.[]' <<<"${names_json}")
  mkdir -p -- "${data_dir}"
  jq . <<<"${entries}" >"${data_dir}/.whitelist.json.next"
  chmod 0644 -- "${data_dir}/.whitelist.json.next"
  # The server rewrites the file when a name is added at its console.
  chown --reference="${data_dir}" -- "${data_dir}/.whitelist.json.next" 2>/dev/null || true
  mv -f -- "${data_dir}/.whitelist.json.next" "${data_dir}/whitelist.json"
  return 0
}

game_reload_whitelist() {
  rcon whitelist reload
  return $?
}

# What a verified archive must contain to count as a save of this game.
game_archive_sentinel_regex() {
  local _world_name="$1"
  printf '^%s/level\\.dat$' "${MINECRAFT_LEVEL_NAME}"
}
