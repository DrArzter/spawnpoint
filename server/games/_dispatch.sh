#!/usr/bin/env bash

# Game dispatch: one game module per directory, selected by the world's `game`
# field in the catalog, defaulting to minecraft everywhere a world is not
# named — which keeps every deployed workflow byte-identical in behaviour.
# A game module is data plus functions, never a daemon:
#
#   GAME_ID                    the id it was loaded as
#   GAME_COMPOSE_FILES         colon list, relative to SERVER_DIR
#   GAME_COMPOSE_SERVICE       the compose service holding the game process
#   GAME_MOD_EXTENSION         what a mod file looks like (jar, zip)
#   GAME_LOADER_TYPE           what manifests carry as loader.type
#   GAME_CONNECT_PORT          the port a player types; the host part of the
#   GAME_CONNECT_PROTOCOL      address comes from the connectivity strategy
#   GAME_DEFAULT_AUTH          this server's auth model: none | game (ADR-0033).
#                              Default to none — see README.md, "Assume the
#                              server authenticates nobody"
#   GAME_FOOTPRINT_MEMORY_MIB  what a session is placed with and limited to when
#   GAME_FOOTPRINT_CORES       the world's catalog entry states nothing (ADR-0054):
#                              the container's memory, not the heap, and a core weight
#   game_ready                 readiness: docker health as $1, succeed when the
#                              game actually serves
#   game_query_players_raw     transport: print the raw player query response
#   game_parse_player_count    parser: raw on stdin -> integer on stdout
#   game_save                  flush the running game to durable storage
#   game_save_paths            print NUL-separated paths under the data dir to archive
#   game_save_sentinel         succeed only if the data dir holds a real save
#   game_prepare_runtime       optional: derive runtime inputs from a verified release manifest
#   game_prepare_installed_runtime optional: restore those inputs for later lifecycle commands
#   game_prepare_session       optional: last-mile files before the container starts
#
# shellcheck shell=bash
# shellcheck disable=SC2034  # GAME_ID is set for consumers, read by its sourcers

GAMES_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

load_game() {
  local game_id="${1:-minecraft}"
  [[ "${game_id}" =~ ^[a-z0-9][a-z0-9-]{0,31}$ ]] || {
    printf 'error: invalid game id: %s\n' "${game_id}" >&2
    exit 1
  }
  local module="${GAMES_DIR}/${game_id}/game.sh"
  [[ -f "${module}" ]] || {
    printf 'error: unknown game: %s (no %s)\n' "${game_id}" "${module}" >&2
    exit 1
  }
  # shellcheck source=/dev/null
  source "${module}"
  GAME_ID="${game_id}"
}

# Resolve which game this invocation is about: an explicit WORLD_ID consults
# the catalog; otherwise SPAWNPOINT_GAME; otherwise the minecraft default that
# predates the axis.
resolve_game() {
  if [[ -n "${WORLD_ID:-}" ]]; then
    # shellcheck source=_worlds.sh
    source "${GAMES_DIR}/../scripts/_worlds.sh"
    load_world "${WORLD_ID}"
    load_game "${WORLD_GAME}"
  else
    load_game "${SPAWNPOINT_GAME:-minecraft}"
  fi
}

# Lifecycle commands are separate processes. Let a game reconstruct any
# Compose inputs derived from the installed release before they source the
# shared Docker helpers. Games without such inputs have nothing to do.
prepare_game_runtime() {
  if declare -F game_prepare_installed_runtime >/dev/null; then
    game_prepare_installed_runtime
  fi
}

# Bind the selected module to the shared Docker helpers. Every lifecycle entry
# point calls this after resolve_game, so a fresh SSM process cannot silently
# fall back to Minecraft's Compose files for another game.
configure_game_compose() {
  local server_dir compose_files compose_file
  server_dir="$(cd -- "${GAMES_DIR}/.." && pwd)"
  if [[ -z "${SERVER_COMPOSE_FILES:-}" && -z "${SERVER_COMPOSE_FILE:-}" ]]; then
    compose_files=""
    IFS=':' read -r -a game_compose <<<"${GAME_COMPOSE_FILES}"
    for compose_file in "${game_compose[@]}"; do
      compose_files="${compose_files:+${compose_files}:}${server_dir}/${compose_file}"
    done
    export SERVER_COMPOSE_FILES="${compose_files}"
  fi
  export SERVER_COMPOSE_SERVICE="${SERVER_COMPOSE_SERVICE:-${GAME_COMPOSE_SERVICE}}"
  return 0
}
