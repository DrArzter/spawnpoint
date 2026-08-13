#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_common.sh
source "${SCRIPT_DIR}/_common.sh"

state="$(container_state)"
health="$(container_health)"

printf 'container_state=%s\n' "${state}"
printf 'container_health=%s\n' "${health}"
printf 'compose_files=%s\n' "$(IFS=:; printf '%s' "${COMPOSE_FILES[*]}")"
printf 'compose_service=%s\n' "${SERVICE}"

if [[ "${state}" != "running" ]]; then
  exit 1
fi

if response="$(rcon list 2>/dev/null)"; then
  printf 'rcon=ready\n'
  printf 'minecraft_status=%s\n' "${response}"
else
  printf 'rcon=unavailable\n'
  exit 1
fi

if [[ "${health}" == "unhealthy" ]]; then
  exit 1
fi
