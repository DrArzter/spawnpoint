#!/usr/bin/env bash

# Palworld: the first game whose player count and save come over its own
# HTTP API (ADR-0076). The dedicated server is Steam app 2394010, which
# installs with an anonymous login. Its RCON is deprecated by its maker, so
# this module does not enable it; the REST API answers the probe, the save
# and the console.
#
# shellcheck shell=bash
# shellcheck disable=SC2034  # the GAME_* constants are the module's interface, read by _dispatch.sh consumers

GAME_COMPOSE_FILES="games/palworld/compose.yaml"
GAME_FOOTPRINT_COMPOSE_FILE="games/palworld/compose.footprint.yaml"
GAME_COMPOSE_SERVICE="palworld"
# No release payload exists for this game, so neither value is ever read by the
# release scripts; they are set for the contract and left honest.
GAME_MOD_EXTENSION=""
GAME_LOADER_TYPE="vanilla"
# The port a player types after the address the connectivity strategy publishes.
GAME_CONNECT_PORT="8211"
GAME_CONNECT_PROTOCOL="udp"
# Palworld's RCON is off. Its REST API port is the probe's transport and takes
# the slot's RCON place; it is bound to localhost (ADR-0076).
GAME_RCON_PORT="8212"
# The client connects to the port the address names. The server names another
# port only to the community list, which this server is not on; compose still
# sets PublicPort from the slot. Not yet proven on a slot other than zero.
GAME_SLOTTABLE="true"
# Fail closed: a server password is one shared secret, not an identity, and
# this configuration verifies no player. A world declares anything stronger
# (ADR-0033, and server/games/README.md).
GAME_DEFAULT_AUTH="none"
# What a session is placed with and limited to (ADR-0054). Documented by
# Pocketpair (16 GB memory, 4 cores recommended; 8 GB boots but crashes more
# often), not yet measured here. Memory growth over a long session is reported.
GAME_FOOTPRINT_MEMORY_MIB="16384"
GAME_FOOTPRINT_CORES="4"

PALWORLD_GAME_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# The REST API's user is fixed by the server; its password is AdminPassword,
# which compose takes from the host's runtime .env.
PALWORLD_REST_USER="admin"
PALWORLD_REST_SECRET="PALWORLD_ADMIN_PASSWORD"
# A save of a large world takes longer than a status read.
PALWORLD_SAVE_TIMEOUT_SECONDS="${PALWORLD_SAVE_TIMEOUT_SECONDS:-60}"

# shellcheck source=../_probes/http.sh
source "${PALWORLD_GAME_DIR}/../_probes/http.sh"

# The host side of the API port follows the slot (ADR-0054), read when a
# request is sent: the slot's ports are exported after the module loads.
palworld_rest_port() {
  printf '%s' "${PALWORLD_REST_PORT:-${SPAWNPOINT_RCON_PORT:-8212}}"
  return 0
}

palworld_rest() {
  local method="$1" api="$2"
  shift 2
  http_probe_request "${method}" "$(palworld_rest_port)" "/v1/api/${api}" \
    "${PALWORLD_REST_USER}" "${PALWORLD_REST_SECRET}" "$@"
  return $?
}

# Two readings, reduced to counts here so no player name, account id or IP
# address leaves the transport: the count /metrics reports, and the length of
# the list /players returns. A reply of another shape is not understood.
game_query_players_raw() {
  local metrics players
  metrics="$(palworld_rest GET metrics)" || return $?
  players="$(palworld_rest GET players)" || return $?
  jq -er 'if (.currentplayernum | type) == "number" and (.maxplayernum | type) == "number"
    then "current_players=\(.currentplayernum)", "max_players=\(.maxplayernum)"
    else error("metrics without player numbers") end' <<<"${metrics}" 2>/dev/null || {
    printf 'error: palworld metrics reply not understood\n' >&2
    return 4
  }
  jq -er 'if (.players | type) == "array" then "listed_players=\(.players | length)"
    else error("no player list") end' <<<"${players}" 2>/dev/null || {
    printf 'error: palworld players reply not understood\n' >&2
    return 4
  }
}

# Players online, only when the two readings agree. A server whose list
# disagrees with its own count is one this parser does not understand, so it
# refuses: the probe reads that as "not idle", and the stop as a refusal.
game_parse_player_count() {
  local response current listed
  response="$(cat)"
  current="$(palworld_value current_players <<<"${response}")" || return 1
  listed="$(palworld_value listed_players <<<"${response}")" || return 1
  (( current == listed )) || return 1
  printf '%s\n' "${current}"
}

# One key, present once, a decimal integer.
palworld_value() {
  local key="$1" values
  values="$(sed -nE "s/^${key}=([0-9]{1,4})\$/\\1/p")"
  [[ "${values}" =~ ^[0-9]{1,4}$ ]] || return 1
  printf '%s' "$((10#${values}))"
}

# The console speaks the REST API's own words. Shutdown and stop end the game
# outside its lifecycle and are refused by the API before they get here (see
# lambdas console.ts); kick and ban need an id the panel does not show. Any
# other word is answered here, as a game answers a command it does not know.
game_console() {
  local command="$1" verb text body
  verb="${command%% *}"
  case "${verb}" in
    info | metrics)
      [[ "${command}" == "${verb}" ]] || { printf '%s takes no argument\n' "${verb}"; return 0; }
      palworld_rest GET "${verb}"
      ;;
    save)
      [[ "${command}" == "${verb}" ]] || { printf 'save takes no argument\n'; return 0; }
      HTTP_PROBE_TIMEOUT_SECONDS="${PALWORLD_SAVE_TIMEOUT_SECONDS}" palworld_rest POST save || return $?
      printf 'saved\n'
      ;;
    announce)
      text="${command#announce}"
      text="${text#"${text%%[![:space:]]*}"}"
      [[ -n "${text}" ]] || { printf 'usage: announce <message>\n'; return 0; }
      body="$(jq -cn --arg message "${text}" '{message: $message}')" || return 1
      palworld_rest POST announce "${body}" || return $?
      printf 'announced\n'
      ;;
    *)
      printf 'unknown command: %s (this console takes info, metrics, save, announce <message>)\n' "${verb}"
      ;;
  esac
}

# The server's own frame time, in milliseconds, from /metrics.
game_tick_time_ms() {
  local metrics frame_ms
  metrics="$(palworld_rest GET metrics)" || return 1
  frame_ms="$(jq -er '.serverframetime | select(type == "number" and . > 0)' <<<"${metrics}" 2>/dev/null)" || {
    printf 'error: palworld metrics reported no frame time\n' >&2
    return 1
  }
  printf '%s\n' "${frame_ms}"
}

# The server writes the world when the REST API asks. A failed call fails the
# save, so the stop refuses rather than archives an unsaved world. The image
# also saves, then shuts down, on the SIGTERM of the graceful stop after this.
game_save() {
  HTTP_PROBE_TIMEOUT_SECONDS="${PALWORLD_SAVE_TIMEOUT_SECONDS}" palworld_rest POST save >/dev/null || return $?
  printf 'save=rest_api\n'
  return 0
}

# Readiness: the image's health check sees the server process, and the API
# answers with two readings that agree.
game_ready() {
  local health="$1"
  [[ "${health}" != "unhealthy" ]] || return 1
  game_query_players_raw 2>/dev/null | game_parse_player_count >/dev/null 2>&1
}

# The data dir is the server's Pal/Saved. A world is SaveGames/0/<guid>/, and
# the guid it loads is DedicatedServerName in GameUserSettings.ini: without
# that file a restored server starts a new world beside the old one.
# PalWorldSettings.ini is rendered from the environment at every start and
# holds the admin password, so it is never archived; neither are the logs.
palworld_world_guid() {
  local data_dir="$1"
  sed -nE 's/^DedicatedServerName=([0-9A-Fa-f]{32})[[:space:]]*$/\1/p' \
    "${data_dir}/Config/LinuxServer/GameUserSettings.ini" 2>/dev/null | head -n1
}

game_save_paths() {
  local data_dir="$1" _world_name="$2"
  local candidate
  for candidate in SaveGames Config/LinuxServer/GameUserSettings.ini; do
    [[ -e "${data_dir}/${candidate}" ]] || continue
    printf '%s\0' "${candidate}"
  done
}

# The world the server's own settings name, with its level file: a save of
# another world, or a pointer to a world that is not there, is not a save.
game_save_sentinel() {
  local data_dir="$1" _world_name="$2" guid
  guid="$(palworld_world_guid "${data_dir}")"
  [[ -n "${guid}" ]] || return 1
  [[ -n "$(find "${data_dir}/SaveGames" -mindepth 3 -maxdepth 3 -type f -path "*/${guid}/Level.sav" -size +0 -print -quit 2>/dev/null)" ]]
}

game_archive_sentinel_regex() {
  local _world_name="$1"
  printf '^SaveGames/[0-9]+/[0-9A-Fa-f]{32}/Level\\.sav$'
}
