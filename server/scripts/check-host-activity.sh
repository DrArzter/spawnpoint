#!/usr/bin/env bash

# The host-idle sensor: is any game session running on this host, other than
# the one asking? This is the seam the two-level stop needs (ADR-0054) — a
# session stop always runs, but the host may only drain when the last session
# leaves. The asking session is its Compose project and service; every other
# game container that runs, in any project, is a neighbour. Same key=value,
# fail-closed contract as the session probe: an unreadable host must never be
# judged idle.

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
GAMES_DIR="${SERVER_DIR}/games"

excluded_service="${1:-}"

export SERVER_PROJECT_DIRECTORY="${SERVER_PROJECT_DIRECTORY:-${SERVER_DIR}}"
compose_project="${SERVER_COMPOSE_PROJECT:-$(basename -- "${SERVER_PROJECT_DIRECTORY}")}"
command -v docker >/dev/null 2>&1 || {
  printf 'result=unavailable\nreason=docker_missing\n'
  exit 2
}

other_active=0
active_services=""
active_projects=""
# Every game container on the host, whichever Compose project it belongs to:
# under ADR-0054 each placed session is its own project, so the asking session
# is (its project, its service) and everything else that runs is a neighbour.
for module in "${GAMES_DIR}"/*/game.sh; do
  observed="$(
    # shellcheck source=/dev/null
    source "${module}"
    ids="$(docker ps --all --quiet --filter "label=com.docker.compose.service=${GAME_COMPOSE_SERVICE}")" || exit 2
    while IFS= read -r id; do
      [[ -n "${id}" ]] || continue
      detail="$(docker inspect --format '{{.State.Status}} {{index .Config.Labels "com.docker.compose.project"}}' "${id}")" || exit 2
      printf '%s %s\n' "${GAME_COMPOSE_SERVICE}" "${detail}"
    done <<<"${ids}"
  )" || {
    printf 'result=unavailable\n'
    printf 'reason=container_inspection_failed\n'
    printf 'module=%s\n' "${module}"
    exit 2
  }

  while read -r name state project; do
    [[ -n "${name}" ]] || continue
    # A container that predates project names carries none; it belongs to the
    # default project, which is what an unplaced session runs as.
    [[ -n "${project}" ]] || project="${compose_project}"
    if [[ "${name}" == "${excluded_service}" && "${project}" == "${compose_project}" ]]; then
      continue
    fi
    if [[ "${state}" == "running" ]]; then
      other_active=$((other_active + 1))
      active_services="${active_services:+${active_services},}${name}"
      active_projects="${active_projects:+${active_projects},}${project}"
    fi
  done <<<"${observed}"
done

printf 'result=observed\n'
printf 'other_active=%s\n' "${other_active}"
printf 'active_services=%s\n' "${active_services:-none}"
printf 'active_projects=%s\n' "${active_projects:-none}"
if (( other_active == 0 )); then
  printf 'host=idle\n'
else
  printf 'host=busy\n'
fi
