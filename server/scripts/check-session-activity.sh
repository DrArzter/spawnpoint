#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"

export SERVER_PROJECT_DIRECTORY="${SERVER_PROJECT_DIRECTORY:-${SERVER_DIR}}"
if [[ -z "${SERVER_COMPOSE_FILES:-}" && -z "${SERVER_COMPOSE_FILE:-}" ]]; then
  export SERVER_COMPOSE_FILES="${SERVER_DIR}/compose.yaml:${SERVER_DIR}/compose.release.yaml"
fi

# The game supplies the transport and the parser; the contract to the
# watchdog — these key=value lines, in this order — never varies by game.
# shellcheck source=../games/_dispatch.sh
source "${SERVER_DIR}/games/_dispatch.sh"
resolve_game
export SERVER_COMPOSE_SERVICE="${SERVER_COMPOSE_SERVICE:-${GAME_COMPOSE_SERVICE}}"

# shellcheck source=_common.sh
source "${SCRIPT_DIR}/_common.sh"

unavailable() {
  local reason="$1"
  local state="${2:-unknown}"

  printf 'result=unavailable\n'
  printf 'activity=unknown\n'
  printf 'container_state=%s\n' "${state}"
  printf 'reason=%s\n' "${reason}"
  exit 2
}

if ! state="$(container_state 2>/dev/null)"; then
  unavailable container_inspection_failed
fi

if [[ "${state}" != "running" ]]; then
  unavailable container_not_running "${state}"
fi

if ! response="$(game_query_players_raw 2>/dev/null)"; then
  unavailable rcon_unavailable "${state}"
fi

if ! count="$(game_parse_player_count <<<"${response}")"; then
  unavailable player_count_unparseable "${state}"
fi

if (( count == 0 )); then
  activity=idle
else
  activity=active
fi

printf 'result=observed\n'
printf 'activity=%s\n' "${activity}"
printf 'container_state=%s\n' "${state}"
printf 'players_online=%s\n' "${count}"
