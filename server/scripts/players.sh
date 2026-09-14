#!/usr/bin/env bash

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

response="$(game_query_players_raw)"
count="$(game_parse_player_count <<<"${response}" || true)"

if [[ -z "${count}" ]]; then
  log "could not parse player count from RCON response: ${response}"
  exit 1
fi

printf 'player_count=%s\n' "${count}"
printf 'player_query=%s\n' "$(tr '\n' ';' <<<"${response}")"
