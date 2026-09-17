#!/usr/bin/env bash

# Game dispatch: one game module per directory, selected by the world's `game`
# field in the catalog, defaulting to minecraft everywhere a world is not
# named — which keeps every deployed workflow byte-identical in behaviour.
# A game module is data plus functions, never a daemon:
#
#   GAME_ID                    the id it was loaded as
#   GAME_COMPOSE_FILES         colon list, relative to SERVER_DIR: what a session
#                              runs, without the observability tier
#   GAME_OBSERVABILITY_COMPOSE_FILES
#   GAME_HOST_OBSERVABILITY_COMPOSE_FILE
#                              optional: the game's part of the observability
#                              tier (its exporter's scrape job, its dashboards),
#                              laid over observability/compose.yaml
#   GAME_FOOTPRINT_COMPOSE_FILE
#                              the overlay that turns the footprint into the
#                              game container's memory limit (ADR-0054)
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
#   GAME_RCON_PORT             the container's RCON port; the host side follows the slot
#   GAME_SLOTTABLE             true when the game can run on a slot other than zero:
#                              its client connects to the port the address names and
#                              the server announces no other. false refuses such a slot
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

# The slot is the port allocator (ADR-0054). Slot zero, and an unplaced
# session, keep the game's own ports; every other slot owns a window of ten
# ports in one host-wide range: +0 the game port, +1 RCON, +2 onward any
# further port the game publishes. The same layout is lambdas/src/domain/placement.ts.
SLOT_PORT_RANGE_START=30000
SLOT_PORT_WINDOW=10
SLOT_MAX=256

configure_slot_ports() {
  local slot="$1" window
  if (( slot == 0 )); then
    export SPAWNPOINT_GAME_PORT="${GAME_CONNECT_PORT}"
    export SPAWNPOINT_RCON_PORT="${GAME_RCON_PORT:-}"
    unset SPAWNPOINT_GAME_PORT_2
  else
    window=$((SLOT_PORT_RANGE_START + slot * SLOT_PORT_WINDOW))
    export SPAWNPOINT_GAME_PORT="${window}"
    export SPAWNPOINT_RCON_PORT="$((window + 1))"
    export SPAWNPOINT_GAME_PORT_2="$((window + 2))"
  fi
  # What the summary tells a player: the host side of the game port.
  export SPAWNPOINT_CONNECT_PORT="${SPAWNPOINT_GAME_PORT}"
}

# Bind the selected module to the shared Docker helpers. Every lifecycle entry
# point calls this after resolve_game, so a fresh SSM process cannot silently
# fall back to Minecraft's Compose files for another game.
#
# A placed session (ADR-0054) arrives with SPAWNPOINT_SLOT. It runs as its own
# Compose project named for its world, on its slot's ports, under its
# footprint's memory limit, and without the observability tier: the host runs
# one tier for every session (observability/compose.host.yaml), which finds the
# game's exporter through GAME_HOST_OBSERVABILITY_COMPOSE_FILE. With no slot the
# session is what it was before placement existed, byte for byte, tier inside.
configure_game_compose() {
  local server_dir compose_files compose_file slot
  server_dir="$(cd -- "${GAMES_DIR}/.." && pwd)"
  slot="${SPAWNPOINT_SLOT:-}"
  if [[ -n "${slot}" ]]; then
    [[ "${slot}" =~ ^(0|[1-9][0-9]{0,2})$ ]] && (( slot < SLOT_MAX )) || {
      printf 'error: SPAWNPOINT_SLOT must be 0..%s, not %s\n' "$((SLOT_MAX - 1))" "${slot}" >&2
      exit 1
    }
    [[ -n "${WORLD_ID:-}" ]] || {
      printf 'error: a placed session names its world (WORLD_ID)\n' >&2
      exit 1
    }
    if (( slot > 0 )) && [[ "${GAME_SLOTTABLE:-false}" != "true" ]]; then
      printf 'error: %s cannot run on slot %s: its server names its own ports to clients (GAME_SLOTTABLE)\n' "${GAME_ID}" "${slot}" >&2
      exit 1
    fi
    [[ -n "${WORLD_FOOTPRINT_MEMORY_MIB:-}" ]] || {
      printf 'error: a placed session carries its footprint (WORLD_FOOTPRINT_MEMORY_MIB)\n' >&2
      exit 1
    }
    export SERVER_COMPOSE_PROJECT="${SERVER_COMPOSE_PROJECT:-spawnpoint-${WORLD_ID}}"
    export SPAWNPOINT_FOOTPRINT_MEMORY_MIB="${WORLD_FOOTPRINT_MEMORY_MIB}"
    configure_slot_ports "${slot}"
  fi
  if [[ -z "${SERVER_COMPOSE_FILES:-}" && -z "${SERVER_COMPOSE_FILE:-}" ]]; then
    local -a session_files=()
    if [[ -z "${slot}" ]]; then
      session_files+=("observability/compose.yaml")
    fi
    IFS=':' read -r -a game_compose <<<"${GAME_COMPOSE_FILES}"
    session_files+=("${game_compose[@]}")
    if [[ -z "${slot}" ]] && [[ -n "${GAME_OBSERVABILITY_COMPOSE_FILES:-}" ]]; then
      IFS=':' read -r -a game_observability <<<"${GAME_OBSERVABILITY_COMPOSE_FILES}"
      session_files+=("${game_observability[@]}")
    fi
    if [[ -n "${slot}" ]]; then
      if [[ -n "${GAME_HOST_OBSERVABILITY_COMPOSE_FILE:-}" ]]; then
        session_files+=("${GAME_HOST_OBSERVABILITY_COMPOSE_FILE}")
      fi
      session_files+=("${GAME_FOOTPRINT_COMPOSE_FILE:?${GAME_ID} declares no GAME_FOOTPRINT_COMPOSE_FILE}")
    fi
    compose_files=""
    for compose_file in "${session_files[@]}"; do
      compose_files="${compose_files:+${compose_files}:}${server_dir}/${compose_file}"
    done
    export SERVER_COMPOSE_FILES="${compose_files}"
  fi
  export SERVER_COMPOSE_SERVICE="${SERVER_COMPOSE_SERVICE:-${GAME_COMPOSE_SERVICE}}"
  return 0
}
