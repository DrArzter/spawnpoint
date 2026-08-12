#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_common.sh
source "${SCRIPT_DIR}/_common.sh"

if [[ "$(container_state)" != "running" ]]; then
  die "Minecraft container is not running; refusing to claim the world was saved"
fi

autosave_disabled=false

restore_autosave() {
  if [[ "${autosave_disabled}" == "true" ]]; then
    rcon save-on >/dev/null || log "warning: failed to re-enable autosave"
  fi
}

trap restore_autosave EXIT

rcon save-off >/dev/null
autosave_disabled=true
save_result="$(rcon save-all flush)"

printf 'save_result=%s\n' "${save_result}"
