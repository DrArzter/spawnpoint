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

# How long a builder step took, for the build log. stderr keeps the result
# lines on stdout parseable; the first call counts from the script's start.
step_timing() {
  local now="${SECONDS}"
  printf 'timing step=%s seconds=%s\n' "$1" "$(( now - ${STEP_TIMING_MARK:-0} ))" >&2
  STEP_TIMING_MARK="${now}"
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

# Compose interpolates the values it reads from an env file, so a value holding
# a dollar sign is read as a reference to a variable nobody set: the value
# reaches the container blank and every single invocation prints a warning for
# it. A CurseForge key is a bcrypt-shaped string, which is three such
# references, and the warnings have been loud enough to fill the 24,000
# characters SSM returns and to sit under every line of the panel's console.
#
# The host's own scripts read the same file and need the value as written, so
# the escaped form is made for Compose alone, beside the file it comes from and
# refreshed whenever that file is newer. Writing it is a convenience, not a
# contract: where the directory is read-only the raw file is used, and the only
# cost is the warnings coming back.
compose_env_file() {
  local escaped="${ENV_FILE}.compose" staged
  if [[ -f "${escaped}" && "${escaped}" -nt "${ENV_FILE}" ]]; then
    printf '%s\n' "${escaped}"
    return 0
  fi
  staged="$(mktemp "${ENV_FILE}.compose.XXXXXX" 2>/dev/null)" || {
    printf '%s\n' "${ENV_FILE}"
    return 0
  }
  if ! sed 's/\$/$$/g' -- "${ENV_FILE}" >"${staged}" || ! chmod 0600 -- "${staged}" ||
    ! mv -f -- "${staged}" "${escaped}"; then
    rm -f -- "${staged}"
    printf '%s\n' "${ENV_FILE}"
    return 0
  fi
  printf '%s\n' "${escaped}"
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
    args+=(--env-file "$(compose_env_file)")
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
