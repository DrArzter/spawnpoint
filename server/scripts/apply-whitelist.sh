#!/usr/bin/env bash

# A world's whitelist changed in the panel while its session runs (ADR-0066),
# for the world named by WORLD_ID on the slot named by SPAWNPOINT_SLOT.
#
# The names are read from the world's record in S3, never from the command:
# the SSM document carries only the world and the slot. They are written where
# the game reads them, and the game is asked to reload the file.
#
# Exit codes: 0 the game reloaded the list; 2 no valid world; 3 the file is
# written but the game did not answer, so it reads the list at its next start;
# 4 the game keeps no whitelist; 5 the world keeps none on its record.

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
runtime_env="${SERVER_ENV_FILE:-${SERVER_DIR}/.env}"

read_env_value() {
  local key="$1"
  [[ -f "${runtime_env}" ]] || return 1
  awk -F= -v key="${key}" '$1 == key { print substr($0, index($0, "=") + 1); found = 1; exit } END { if (!found) exit 1 }' \
    "${runtime_env}"
}

[[ "${WORLD_ID:-}" =~ ^[a-z0-9][a-z0-9-]{0,31}$ ]] || {
  printf 'error: WORLD_ID must name a world\n' >&2
  exit 2
}

# A catalog of its own. The host's shared one is what its running sessions
# were started with, and refreshing it here would drop another world's entry.
runtime="$(mktemp -d)"
trap 'rm -rf -- "${runtime}"' EXIT
release_bucket="${RELEASE_BUCKET:-$(read_env_value RELEASE_BUCKET 2>/dev/null || true)}"
catalog_output="$(RELEASE_BUCKET="${release_bucket}" SPAWNPOINT_RUNTIME_DIRECTORY="${runtime}" "${SCRIPT_DIR}/refresh-world-catalog.sh" "${WORLD_ID}")"
export SPAWNPOINT_WORLD_CATALOG
SPAWNPOINT_WORLD_CATALOG="$(awk -F= '$1 == "catalog" { print substr($0, index($0, "=") + 1) }' <<<"${catalog_output}")"
[[ -n "${SPAWNPOINT_WORLD_CATALOG}" ]] || { printf 'error: world catalog refresh returned no path\n' >&2; exit 1; }

# shellcheck source=../games/_dispatch.sh
source "${SERVER_DIR}/games/_dispatch.sh"
resolve_game
prepare_game_runtime
configure_game_compose
export SERVER_PROJECT_DIRECTORY="${SERVER_PROJECT_DIRECTORY:-${SERVER_DIR}}"

# shellcheck source=_common.sh
source "${SCRIPT_DIR}/_common.sh"

[[ -n "${WORLD_WHITELIST:-}" ]] || {
  printf 'error: world %s keeps no whitelist on its record\n' "${WORLD_ID}" >&2
  exit 5
}
declare -F game_render_whitelist >/dev/null && declare -F game_reload_whitelist >/dev/null || {
  printf 'error: %s keeps no whitelist\n' "${GAME_ID}" >&2
  exit 4
}

game_render_whitelist "${WORLD_DATA_DIRECTORY}" "${WORLD_WHITELIST}"
names="$(jq 'length' <<<"${WORLD_WHITELIST}")"
if ! reply="$(game_reload_whitelist 2>&1)"; then
  printf '%s\n' "${reply}"
  printf 'result=written_not_reloaded\nnames=%s\n' "${names}"
  exit 3
fi
printf '%s\n' "${reply}"
printf 'result=reloaded\nnames=%s\n' "${names}"
