#!/usr/bin/env bash

# The recent log of the world named by WORLD_ID on the slot named by
# SPAWNPOINT_SLOT (ADR-0094): the game container's last lines, newest last.
#
# The script takes no text from a person. It prints at most MAX_BYTES of the
# log's tail, because SSM keeps about 24,000 characters of a command's output.
# The API removes addresses and player names before anyone reads it.
#
# Exit codes: 0 the log was read; 3 the game has no container to read.

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"

MAX_LINES=200
MAX_BYTES=20000

# shellcheck source=../games/_dispatch.sh
source "${SERVER_DIR}/games/_dispatch.sh"
resolve_game
prepare_game_runtime
configure_game_compose
export SERVER_PROJECT_DIRECTORY="${SERVER_PROJECT_DIRECTORY:-${SERVER_DIR}}"

# shellcheck source=_common.sh
source "${SCRIPT_DIR}/_common.sh"

[[ -n "${SERVICE}" ]] || {
  printf 'error: %s names no game service\n' "${GAME_ID}" >&2
  exit 3
}

transport="$(mktemp)"
trap 'rm -f -- "${transport}"' EXIT
if ! log="$(compose logs --no-color --no-log-prefix --tail "${MAX_LINES}" "${SERVICE}" 2>"${transport}")"; then
  cat -- "${transport}" >&2
  exit 3
fi
# The newest lines matter most, so a long log loses its oldest bytes.
printf '%s\n' "${log}" | redact_secrets | tail -c "${MAX_BYTES}"
