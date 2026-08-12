#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_common.sh
source "${SCRIPT_DIR}/_common.sh"

state="$(container_state)"

if [[ "${state}" == "absent" ]] || [[ "${state}" == "exited" ]]; then
  # Observability is session-scoped. Do not leave it running if Minecraft was
  # stopped independently or never created.
  compose stop >/dev/null
  printf 'result=already_stopped\n'
  exit 0
fi

if [[ "${state}" != "running" ]]; then
  die "Minecraft container is in unexpected state: ${state}"
fi

"${SCRIPT_DIR}/save-world.sh"
compose stop >/dev/null

final_state="$(container_state)"
if [[ "${final_state}" != "exited" ]]; then
  die "container did not stop cleanly; current state: ${final_state}"
fi

printf 'result=stopped\n'
