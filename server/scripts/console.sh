#!/usr/bin/env bash

# One console command an operator typed in the panel (ADR-0063), run against
# the world named by WORLD_ID on the slot named by SPAWNPOINT_SLOT.
#
# The command arrives base64-encoded in CONSOLE_COMMAND_B64, so no shell
# between the API and this script ever reads it as code. It is decoded here,
# held to one printable line, and handed to the game's own RCON transport as a
# single argument. The reply is printed as the game wrote it.
#
# Exit codes: 0 the game answered; 2 the command is not one line of text;
# 3 the game did not answer (not running, RCON down); 4 the game has no console.

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"

MAX_COMMAND_LENGTH=1024

encoded="${CONSOLE_COMMAND_B64:-}"
# The length is checked apart from the pattern: POSIX promises repetition
# bounds only up to 255, and musl refuses larger ones.
[[ "${#encoded}" -le 1400 && "${encoded}" =~ ^[A-Za-z0-9+/]+={0,2}$ ]] || {
  printf 'error: CONSOLE_COMMAND_B64 must be base64\n' >&2
  exit 2
}
# A sentinel keeps a trailing newline the shell would otherwise strip, so a
# command that smuggles a second line is still seen and refused.
if ! decoded="$(printf '%s' "${encoded}" | base64 -d 2>/dev/null && printf 'x')"; then
  printf 'error: CONSOLE_COMMAND_B64 does not decode\n' >&2
  exit 2
fi
command="${decoded%x}"
if [[ -z "${command//[[:space:]]/}" || "${#command}" -gt "${MAX_COMMAND_LENGTH}" || "${command}" =~ [[:cntrl:]] ]]; then
  # The API holds a command to 256 characters; this bounds the bytes whatever the locale.
  printf 'error: a console command is one line of at most %s bytes\n' "${MAX_COMMAND_LENGTH}" >&2
  exit 2
fi

# shellcheck source=../games/_dispatch.sh
source "${SERVER_DIR}/games/_dispatch.sh"
resolve_game
prepare_game_runtime
configure_game_compose
export SERVER_PROJECT_DIRECTORY="${SERVER_PROJECT_DIRECTORY:-${SERVER_DIR}}"

# shellcheck source=_common.sh
source "${SCRIPT_DIR}/_common.sh"

declare -F game_console >/dev/null || {
  printf 'error: %s has no console\n' "${GAME_ID}" >&2
  exit 4
}

if ! reply="$(game_console "${command}" 2>&1)"; then
  printf '%s\n' "${reply}"
  exit 3
fi
printf '%s\n' "${reply}"
