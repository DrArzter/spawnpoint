#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
runtime_env="${SERVER_ENV_FILE:-${SERVER_DIR}/.env}"

read_env_value() {
  local key="$1"
  awk -F= -v key="${key}" '$1 == key { print substr($0, index($0, "=") + 1); found = 1; exit } END { if (!found) exit 1 }' \
    "${runtime_env}"
}

[[ -f "${runtime_env}" ]] || {
  printf 'error: runtime environment does not exist: %s\n' "${runtime_env}" >&2
  exit 1
}

backup_bucket="${BACKUP_BUCKET:-$(read_env_value BACKUP_BUCKET)}"
aws_region="${AWS_REGION:-$(read_env_value AWS_REGION)}"
[[ "${backup_bucket}" =~ ^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$ ]] || {
  printf 'error: invalid BACKUP_BUCKET in runtime environment\n' >&2
  exit 1
}
[[ "${aws_region}" =~ ^[a-z]{2}-[a-z]+-[0-9]+$ ]] || {
  printf 'error: invalid AWS_REGION in runtime environment\n' >&2
  exit 1
}

# shellcheck source=../games/_dispatch.sh
source "${SERVER_DIR}/games/_dispatch.sh"
resolve_game
prepare_game_runtime
configure_game_compose

if [[ "${WORLD_STORAGE_LAYOUT:-legacy}" == "generation" ]]; then
  export SERVER_DATA_DIR="${WORLD_DATA_DIRECTORY}"
  export WORLD_NAME="${WORLD_ID}"
  # Child archive/upload processes must bind the immutable backup to the exact
  # generation it came from. The id is also encoded in the object name, so the
  # control plane can select restores without downloading world data.
  export WORLD_GENERATION_ID WORLD_RELEASE
fi

export SERVER_PROJECT_DIRECTORY="${SERVER_DIR}"

# shellcheck source=_common.sh
source "${SCRIPT_DIR}/_common.sh"

state="$(container_state)"
if [[ "${state}" == "absent" || "${state}" == "exited" ]]; then
  # Make the whole session invariant true even if the game was stopped by a
  # previous attempt while an exporter remained alive.
  compose stop >/dev/null
  printf 'result=already_stopped\n'
  exit 0
fi
[[ "${state}" == "running" ]] || {
  printf 'error: game container is in unexpected state: %s\n' "${state}" >&2
  exit 1
}

players="$(game_query_players_raw)"
player_count="$(game_parse_player_count <<<"${players}")" || {
  printf 'error: refusing to stop on an unreadable player count: %s\n' "${players}" >&2
  exit 1
}
[[ "${player_count}" == "0" ]] || {
  printf 'error: refusing to stop while players are online: %s\n' "${players}" >&2
  # A player raced the earlier idle observation. This is a normal refusal,
  # distinct from save, archive and upload failures.
  exit 3
}

"${SCRIPT_DIR}/stop.sh"
archive_output="$("${SCRIPT_DIR}/archive-world.sh")"
archive="$(awk -F= '$1 == "archive" { print substr($0, index($0, "=") + 1) }' <<<"${archive_output}")"
[[ -n "${archive}" ]] || {
  printf 'error: archive-world.sh did not report an archive path\n' >&2
  exit 1
}

upload_output="$(
  BACKUP_BUCKET="${backup_bucket}" \
  AWS_REGION="${aws_region}" \
    "${SCRIPT_DIR}/upload-world-backup.sh" "${archive}"
)"

printf '%s\n' "${archive_output}"
printf '%s\n' "${upload_output}"

# Last one out turns off the lights. The session this command was asked about is
# stopped and backed up; whether the *host* may sleep is a separate question,
# and its answer is an exit code rather than a line to parse:
#   0  nothing else is active — the instance may stop
#   4  another game on this host is still busy — leave the instance running
#   5  the answer could not be read — fail closed, and be loud about it
# With one game on the host the answer is always 0, which is why this can land
# before the topology it protects.
host_activity=0
host_output="$("${SCRIPT_DIR}/check-host-activity.sh" "${SERVER_COMPOSE_SERVICE}")" || host_activity=$?
printf '%s\n' "${host_output}"
printf 'result=session_stopped_and_backed_up\n'

if (( host_activity != 0 )); then
  printf 'error: could not determine whether other games are active on this host\n' >&2
  exit 5
fi
if ! grep -qx 'host=idle' <<<"${host_output}"; then
  exit 4
fi
