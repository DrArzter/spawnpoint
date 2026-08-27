#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
# shellcheck source=../games/_dispatch.sh
source "${SERVER_DIR}/games/_dispatch.sh"
resolve_game
export SERVER_COMPOSE_SERVICE="${SERVER_COMPOSE_SERVICE:-${GAME_COMPOSE_SERVICE}}"
# shellcheck source=_common.sh
source "${SCRIPT_DIR}/_common.sh"

state="$(container_state)"
health="$(container_health)"

printf 'container_state=%s\n' "${state}"
printf 'container_health=%s\n' "${health}"
printf 'compose_files=%s\n' "$(IFS=:; printf '%s' "${COMPOSE_FILES[*]}")"
printf 'compose_service=%s\n' "${SERVICE}"
printf 'game=%s\n' "${GAME_ID}"

if [[ "${state}" != "running" ]]; then
  exit 1
fi

# One line per key: a player query answers in the game's own format, and
# factorio's spans several lines.
if response="$(game_query_players_raw 2>/dev/null)"; then
  printf 'control_path=ready\n'
  printf 'player_query=%s\n' "$(tr '\n' ';' <<<"${response}")"
else
  printf 'control_path=unavailable\n'
  exit 1
fi

if [[ "${health}" == "unhealthy" ]]; then
  exit 1
fi
