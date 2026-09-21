#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_SERVER_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
SERVER_DIR="$(realpath -m -- "${SERVER_PROJECT_DIRECTORY:-${DEFAULT_SERVER_DIR}}")"
ENV_FILE="$(realpath -m -- "${SERVER_ENV_FILE:-${SERVER_DIR}/.env}")"
SERVICE="${SERVER_COMPOSE_SERVICE:-mc}"

declare -a COMPOSE_FILES=()
if [[ -n "${SERVER_COMPOSE_FILES:-}" ]]; then
  IFS=':' read -r -a configured_compose_files <<<"${SERVER_COMPOSE_FILES}"
  for compose_file in "${configured_compose_files[@]}"; do
    [[ -n "${compose_file}" ]] || continue
    COMPOSE_FILES+=("$(realpath -m -- "${compose_file}")")
  done
else
  COMPOSE_FILES+=("$(realpath -m -- "${SERVER_COMPOSE_FILE:-${SERVER_DIR}/compose.yaml}")")
fi

(( ${#COMPOSE_FILES[@]} > 0 )) || {
  printf 'error: SERVER_COMPOSE_FILES did not contain a Compose file\n' >&2
  exit 1
}

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
  local args=(--project-directory "${SERVER_DIR}")
  # A placed session is its own Compose project, named for its world, so two
  # sessions on one host never share a container name or a volume. Unset keeps
  # Compose's own default, the directory's name, exactly as before.
  if [[ -n "${SERVER_COMPOSE_PROJECT:-}" ]]; then
    args+=(--project-name "${SERVER_COMPOSE_PROJECT}")
  fi

  for compose_file in "${COMPOSE_FILES[@]}"; do
    args+=(-f "${compose_file}")
  done

  if [[ -f "${ENV_FILE}" ]]; then
    args+=(--env-file "${ENV_FILE}")
  fi

  docker compose "${args[@]}" "$@"
}

validate_compose() {
  require_command docker
  local compose_file
  for compose_file in "${COMPOSE_FILES[@]}"; do
    [[ -f "${compose_file}" ]] || die "Compose file does not exist: ${compose_file}"
  done

  if ! compose config --quiet; then
    die "Compose configuration is invalid; check the configured Compose files and ${ENV_FILE}"
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
    die "could not inspect Compose service ${SERVICE}"
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
    die "could not inspect Compose service ${SERVICE}"
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
