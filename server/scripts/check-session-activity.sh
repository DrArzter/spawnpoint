#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"

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
configure_game_compose
export SERVER_PROJECT_DIRECTORY="${SERVER_PROJECT_DIRECTORY:-${SERVER_DIR}}"

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

# Memory as the kernel counts it: what is not available is used. The host is
# the only place that knows it, so the watchdog collects it with the players
# and publishes it (ADR-0015). A host without it reports none; a missing figure
# never fails the probe, because the probe's job is the player count.
# Prints one JSON object, empty when the figures cannot be read.
memory_json() {
  awk '
    $1 == "MemTotal:" { total = $2 }
    $1 == "MemAvailable:" { available = $2 }
    END {
      if (total > 0 && available != "" && available <= total) {
        printf "{\"totalKb\":%d,\"availableKb\":%d,\"usedPercent\":%.1f}", total, available, (total - available) * 100 / total
      } else {
        printf "{}"
      }
    }' "${MEMINFO_FILE:-/proc/meminfo}" 2>/dev/null || printf '{}'
}

# No trailing newline in JSON mode: the machine reads the invocation output
# whole, and a document is easier to trust than a document plus whitespace.
report() {
  local result="$1" activity="$2" state="$3" players="$4" reason="$5"
  local memory
  memory="$(memory_json)"
  if [[ "${probe_format}" == "json" ]]; then
    jq -cn \
      --argjson memory "${memory}" \
      --arg result "${result}" \
      --arg activity "${activity}" \
      --arg containerState "${state}" \
      --arg reason "${reason}" \
      --argjson playersOnline "${players}" \
      '{result: $result, activity: $activity, containerState: $containerState, playersOnline: $playersOnline}
       + (if $reason == "" then {} else {reason: $reason} end)
       + (if $memory == {} then {} else {memory: $memory} end)' | tr -d '\n'
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
  if [[ "${memory}" != "{}" ]]; then
    printf 'memory_used_percent=%s\n' "$(jq -r '.usedPercent' <<<"${memory}")"
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
