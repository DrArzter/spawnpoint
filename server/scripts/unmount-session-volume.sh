#!/usr/bin/env bash
# Unmount a world's session volume (ADR-0102) after its archive is in S3, so
# the control plane can detach and delete it. Nothing mounted is not an error:
# a retried stop finds the volume already gone.

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_worlds.sh
source "${SCRIPT_DIR}/_worlds.sh"

[[ $# -eq 1 ]] || {
  printf 'usage: %s <world-id>\n' "$0" >&2
  exit 2
}
world_id="$1"
[[ "${world_id}" =~ ^[a-z0-9][a-z0-9-]{0,31}$ ]] || {
  printf 'error: invalid world id: %s\n' "${world_id}" >&2
  exit 2
}

mount_point="${WORLDS_DIRECTORY}/${world_id}"
if ! findmnt -nro TARGET --mountpoint "${mount_point}" >/dev/null 2>&1; then
  printf 'unmounted=false\nmount=%s\n' "${mount_point}"
  exit 0
fi
sync -f -- "${mount_point}"
umount -- "${mount_point}"
printf 'unmounted=true\nmount=%s\n' "${mount_point}"
