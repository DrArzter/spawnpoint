#!/usr/bin/env bash

# One tick-time reading of the running session, for the acceptance of ADR-0054:
# the same world measured alone and beside a neighbour is the figure the core
# weight rests on. Runs through the same dispatch as every session command, so
# a placed session (WORLD_ID and SPAWNPOINT_SLOT) reads its own project.
#
# Output, key=value:
#   game=<id> world=<id> slot=<n or none> players_online=<n>
#   tick_ms=<milliseconds, or unsupported>
#   sampled_at=<UTC, ISO 8601>
# Exit 2 when the game cannot report one; the rest of the line is still true.

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
# shellcheck source=../games/_dispatch.sh
source "${SERVER_DIR}/games/_dispatch.sh"
resolve_game
prepare_game_runtime
configure_game_compose
# shellcheck source=_common.sh
source "${SCRIPT_DIR}/_common.sh"

players_output="$("${SCRIPT_DIR}/players.sh")"
players_online="$(awk -F= '$1 == "player_count" { print $2 }' <<<"${players_output}")"

printf 'game=%s\n' "${GAME_ID}"
printf 'world=%s\n' "${WORLD_ID:-${WORLD_NAME:-world}}"
printf 'slot=%s\n' "${SPAWNPOINT_SLOT:-none}"
printf 'players_online=%s\n' "${players_online}"
printf 'sampled_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"

status=0
tick_ms="$(game_tick_time_ms)" || status=$?
if (( status == 2 )); then
  printf 'tick_ms=unsupported\n'
  exit 2
fi
(( status == 0 )) || exit "${status}"
printf 'tick_ms=%s\n' "${tick_ms}"
