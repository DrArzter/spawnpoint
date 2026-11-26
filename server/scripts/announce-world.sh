#!/usr/bin/env bash
# Show one line of text to the players of a running session (ADR-0102), through
# the game's optional game_announce hook. A game without the hook is not an
# error: it reports announced=false.

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
# shellcheck source=../games/_dispatch.sh
source "${SERVER_DIR}/games/_dispatch.sh"
resolve_game
configure_game_compose

# shellcheck source=_common.sh
source "${SCRIPT_DIR}/_common.sh"

[[ $# -eq 1 && -n "$1" ]] || die "usage: $0 <text>"

if ! declare -F game_announce >/dev/null; then
  printf 'announced=false\nreason=unsupported\n'
  exit 0
fi
if [[ "$(container_state)" != "running" ]]; then
  printf 'announced=false\nreason=not_running\n'
  exit 0
fi
if game_announce "$1" >/dev/null; then
  printf 'announced=true\nreason=none\n'
else
  printf 'announced=false\nreason=failed\n'
fi
