#!/usr/bin/env bash

# The host-idle sensor: is any game service running on this host, other than
# the one asking? This is the seam the two-level stop needs — a world-level
# stop always runs, but StopInstances is only correct when the last session
# leaves. Today one world runs at a time and the answer is trivially "idle";
# the seam exists so lifting that assumption changes a Choice state, not the
# plumbing. Same key=value, fail-closed contract as the session probe:
# an unreadable host must never be judged idle.

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
GAMES_DIR="${SERVER_DIR}/games"

excluded_service="${1:-}"

export SERVER_PROJECT_DIRECTORY="${SERVER_PROJECT_DIRECTORY:-${SERVER_DIR}}"

other_active=0
active_services=""
for module in "${GAMES_DIR}"/*/game.sh; do
  service="$(
    # shellcheck source=/dev/null
    source "${module}"
    compose_files=""
    IFS=':' read -r -a game_compose <<<"${GAME_COMPOSE_FILES}"
    for compose_file in "${game_compose[@]}"; do
      compose_files="${compose_files:+${compose_files}:}${SERVER_DIR}/${compose_file}"
    done
    state="$(
      SERVER_COMPOSE_FILES="${compose_files}" \
      SERVER_COMPOSE_SERVICE="${GAME_COMPOSE_SERVICE}" \
        "${SCRIPT_DIR}/status-container-state.sh" 2>/dev/null
    )" || exit 2
    printf '%s=%s\n' "${GAME_COMPOSE_SERVICE}" "${state}"
  )" || {
    printf 'result=unavailable\n'
    printf 'reason=container_inspection_failed\n'
    printf 'module=%s\n' "${module}"
    exit 2
  }

  name="${service%%=*}"
  state="${service#*=}"
  [[ "${name}" == "${excluded_service}" ]] && continue
  if [[ "${state}" == "running" ]]; then
    other_active=$((other_active + 1))
    active_services="${active_services:+${active_services},}${name}"
  fi
done

printf 'result=observed\n'
printf 'other_active=%s\n' "${other_active}"
printf 'active_services=%s\n' "${active_services:-none}"
if (( other_active == 0 )); then
  printf 'host=idle\n'
else
  printf 'host=busy\n'
fi
