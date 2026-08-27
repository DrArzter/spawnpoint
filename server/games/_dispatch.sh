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
#   game_query_players_raw     transport: print the raw player query response
#   game_parse_player_count    parser: raw on stdin -> integer on stdout
#   game_save_paths            print NUL-separated paths under the data dir to archive
#   game_save_sentinel         succeed only if the data dir holds a real save
#   game_prepare_session       optional: last-mile files before the container starts
#
# shellcheck shell=bash

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
