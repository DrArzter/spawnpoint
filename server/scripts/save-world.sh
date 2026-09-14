#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
# shellcheck source=../games/_dispatch.sh
source "${SERVER_DIR}/games/_dispatch.sh"
resolve_game
configure_game_compose

# shellcheck source=_common.sh
source "${SCRIPT_DIR}/_common.sh"

if [[ "$(container_state)" != "running" ]]; then
  die "${GAME_ID} container is not running; refusing to claim the world was saved"
fi

declare -F game_save >/dev/null || die "game adapter ${GAME_ID} does not implement game_save"
save_result="$(game_save)"

printf 'save_result=%s\n' "${save_result}"
