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

timeout_seconds="${START_TIMEOUT_SECONDS:-600}"
poll_seconds="${START_POLL_SECONDS:-5}"

[[ "${timeout_seconds}" =~ ^[1-9][0-9]*$ ]] || die "START_TIMEOUT_SECONDS must be a positive integer"
[[ "${poll_seconds}" =~ ^[1-9][0-9]*$ ]] || die "START_POLL_SECONDS must be a positive integer"

started_at="${SECONDS}"

initial_state="$(container_state)"
initial_health="$(container_health)"
if [[ "${initial_state}" == "running" ]] && game_ready "${initial_health}"; then
  # The game may already be ready while one of the session-scoped supporting
  # services is absent. Start missing services without recreating the game.
  compose up -d --no-recreate >/dev/null
  printf 'result=already_ready\n'
  printf 'elapsed_seconds=0\n'
  exit 0
fi

compose up -d >/dev/null

while (( SECONDS - started_at < timeout_seconds )); do
  state="$(container_state)"
  health="$(container_health)"

  if [[ "${state}" == "running" ]]; then
    if game_ready "${health}"; then
      printf 'result=ready\n'
      printf 'elapsed_seconds=%s\n' "$((SECONDS - started_at))"
      printf 'container_health=%s\n' "${health}"
      exit 0
    fi
  elif [[ "${state}" == "exited" ]] || [[ "${state}" == "dead" ]]; then
    log "${GAME_ID} container entered state ${state} while starting"
    compose logs --tail 80 "${SERVICE}" >&2 || true
    exit 1
  fi

  sleep "${poll_seconds}"
done

log "${GAME_ID} did not become ready within ${timeout_seconds} seconds"
compose logs --tail 80 "${SERVICE}" >&2 || true
exit 1
