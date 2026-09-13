#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"

export SERVER_PROJECT_DIRECTORY="${SERVER_PROJECT_DIRECTORY:-${SERVER_DIR}}"
if [[ -z "${SERVER_COMPOSE_FILES:-}" && -z "${SERVER_COMPOSE_FILE:-}" ]]; then
  export SERVER_COMPOSE_FILES="${SERVER_DIR}/compose.yaml:${SERVER_DIR}/compose.release.yaml"
fi

# The game supplies the transport and the parser; the contract to the watchdog
# never varies by game. Two output shapes, same fields: key=value lines for a
# human reading an SSM invocation, and a single JSON document when
# PROBE_FORMAT=json, which is what a state machine should consume — ASL can
# parse a document by name, while splitting lines makes the machine depend on
# the order they are printed in.
# shellcheck source=../games/_dispatch.sh
source "${SERVER_DIR}/games/_dispatch.sh"
resolve_game
prepare_game_runtime
export SERVER_COMPOSE_SERVICE="${SERVER_COMPOSE_SERVICE:-${GAME_COMPOSE_SERVICE}}"

# shellcheck source=_common.sh
source "${SCRIPT_DIR}/_common.sh"

probe_format="${PROBE_FORMAT:-lines}"
case "${probe_format}" in
  lines | json) ;;
  *)
    printf 'error: PROBE_FORMAT must be lines or json: %s\n' "${probe_format}" >&2
    exit 2
    ;;
esac

# No trailing newline in JSON mode: the machine reads the invocation output
# whole, and a document is easier to trust than a document plus whitespace.
report() {
  local result="$1" activity="$2" state="$3" players="$4" reason="$5"
  if [[ "${probe_format}" == "json" ]]; then
    jq -cn \
      --arg result "${result}" \
      --arg activity "${activity}" \
      --arg containerState "${state}" \
      --arg reason "${reason}" \
      --argjson playersOnline "${players}" \
      '{result: $result, activity: $activity, containerState: $containerState, playersOnline: $playersOnline}
       + (if $reason == "" then {} else {reason: $reason} end)' | tr -d '\n'
    return 0
  fi
  printf 'result=%s\n' "${result}"
  printf 'activity=%s\n' "${activity}"
  printf 'container_state=%s\n' "${state}"
  if [[ -n "${reason}" ]]; then
    printf 'reason=%s\n' "${reason}"
  else
    printf 'players_online=%s\n' "${players}"
  fi
}

unavailable() {
  local reason="$1"
  local state="${2:-unknown}"

  report unavailable unknown "${state}" null "${reason}"
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

report observed "${activity}" "${state}" "${count}" ""
