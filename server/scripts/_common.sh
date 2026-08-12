#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_SERVER_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
SERVER_DIR="$(realpath -m -- "${SERVER_PROJECT_DIRECTORY:-${DEFAULT_SERVER_DIR}}")"
COMPOSE_FILE="$(realpath -m -- "${SERVER_COMPOSE_FILE:-${SERVER_DIR}/compose.yaml}")"
ENV_FILE="$(realpath -m -- "${SERVER_ENV_FILE:-${SERVER_DIR}/.env}")"
SERVICE="${SERVER_COMPOSE_SERVICE:-mc}"

log() {
  printf '%s\n' "$*" >&2
}

die() {
  log "error: $*"
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

compose() {
  local args=(--project-directory "${SERVER_DIR}" -f "${COMPOSE_FILE}")

  if [[ -f "${ENV_FILE}" ]]; then
    args+=(--env-file "${ENV_FILE}")
  fi

  docker compose "${args[@]}" "$@"
}

validate_compose() {
  require_command docker
  [[ -f "${COMPOSE_FILE}" ]] || die "Compose file does not exist: ${COMPOSE_FILE}"

  if ! compose config --quiet; then
    die "Compose configuration is invalid; check ${COMPOSE_FILE} and ${ENV_FILE}"
  fi
}

container_id() {
  validate_compose
  # `docker compose ps -q` hides stopped containers. Lifecycle checks need to
  # distinguish an existing `exited` container from one that was never created.
  compose ps --all --quiet "${SERVICE}"
}

container_state() {
  local id
  if ! id="$(container_id)"; then
    die "could not inspect Compose service ${SERVICE} in ${COMPOSE_FILE}"
  fi

  if [[ -z "${id}" ]]; then
    printf 'absent\n'
    return 0
  fi

  docker inspect --format '{{.State.Status}}' "${id}"
}

container_health() {
  local id
  if ! id="$(container_id)"; then
    die "could not inspect Compose service ${SERVICE} in ${COMPOSE_FILE}"
  fi

  if [[ -z "${id}" ]]; then
    printf 'none\n'
    return 0
  fi

  docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "${id}"
}

rcon() {
  validate_compose
  compose exec -T "${SERVICE}" rcon-cli "$@"
}
