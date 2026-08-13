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

export SERVER_PROJECT_DIRECTORY="${SERVER_DIR}"
export SERVER_COMPOSE_FILES="${SERVER_DIR}/compose.yaml:${SERVER_DIR}/compose.release.yaml"

# shellcheck source=_common.sh
source "${SCRIPT_DIR}/_common.sh"

state="$(container_state)"
if [[ "${state}" == "absent" || "${state}" == "exited" ]]; then
  # Make the whole session invariant true even if Minecraft was stopped by a
  # previous attempt while an exporter remained alive.
  compose stop >/dev/null
  printf 'result=already_stopped\n'
  exit 0
fi
[[ "${state}" == "running" ]] || {
  printf 'error: Minecraft container is in unexpected state: %s\n' "${state}" >&2
  exit 1
}

players="$(rcon list)"
grep -Eq '^There are 0 of a max of [0-9]+ players online:' <<<"${players}" || {
  printf 'error: refusing to stop while players are online: %s\n' "${players}" >&2
  exit 1
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
printf 'result=session_stopped_and_backed_up\n'
