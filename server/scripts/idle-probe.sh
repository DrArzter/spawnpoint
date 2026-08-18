#!/usr/bin/env bash

# Exit-code contract for the idle watchdog, so the workflow never parses stdout:
#   0  nobody online — counts toward the empty streak
#   3  players online — resets the streak
#   *  probe failure — fails closed as "not empty" (ADR-0006)
# players.sh already fails on an unparseable RCON response; that propagates as a
# non-zero, non-3 exit and is counted as a probe failure, never as empty.

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

output="$("${SCRIPT_DIR}/players.sh")"
count="$(awk -F= '$1 == "player_count" { print $2 }' <<<"${output}")"

[[ "${count}" =~ ^[0-9]+$ ]] || {
  printf 'error: players.sh did not report a numeric player_count\n' >&2
  exit 1
}

printf 'player_count=%s\n' "${count}"

if (( count == 0 )); then
  exit 0
fi
exit 3
