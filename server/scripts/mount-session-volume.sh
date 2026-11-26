#!/usr/bin/env bash
# Mount a session volume (ADR-0102) at the world's directory. The volume is
# found by its id, never by a device name: Nitro renames /dev/sdf to NVMe.
# A new volume has no filesystem and is formatted; a volume attached again
# after an interruption keeps its filesystem and the world on it.

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_worlds.sh
source "${SCRIPT_DIR}/_worlds.sh"

readonly DEVICE_DIRECTORY="${SPAWNPOINT_DEVICE_DIRECTORY:-/dev/disk/by-id}"
readonly DEVICE_WAIT_SECONDS="${SPAWNPOINT_DEVICE_WAIT_SECONDS:-60}"
# XFS labels are limited to 12 characters.
readonly SESSION_LABEL="spsession"

[[ $# -eq 2 ]] || {
  printf 'usage: %s <world-id> <volume-id>\n' "$0" >&2
  exit 2
}
world_id="$1"
volume_id="$2"
[[ "${world_id}" =~ ^[a-z0-9][a-z0-9-]{0,31}$ ]] || {
  printf 'error: invalid world id: %s\n' "${world_id}" >&2
  exit 2
}
[[ "${volume_id}" =~ ^vol-[0-9a-f]{8,17}$ ]] || {
  printf 'error: invalid volume id: %s\n' "${volume_id}" >&2
  exit 2
}

# The NVMe serial is the volume id without its dash.
device="${DEVICE_DIRECTORY}/nvme-Amazon_Elastic_Block_Store_${volume_id//-/}"
waited=0
until [[ -e "${device}" ]]; do
  (( waited < DEVICE_WAIT_SECONDS )) || {
    printf 'error: volume %s is not attached to this host\n' "${volume_id}" >&2
    exit 1
  }
  sleep 1
  waited=$((waited + 1))
done
device="$(readlink -f -- "${device}")"

root_source="$(readlink -f -- "$(findmnt -nro SOURCE /)")"
root_parent="$(lsblk -nro PKNAME "${root_source}" | head -n 1)"
if [[ "${device}" == "${root_source}" || (-n "${root_parent}" && "${device}" == "/dev/${root_parent}") ]]; then
  printf 'error: refusing the root filesystem device: %s\n' "${device}" >&2
  exit 1
fi

mount_point="${WORLDS_DIRECTORY}/${world_id}"
[[ ! -L "${mount_point}" ]] || {
  printf 'error: world path is a symbolic link: %s\n' "${mount_point}" >&2
  exit 1
}

existing_target="$(findmnt -nro TARGET --source "${device}" 2>/dev/null || true)"
if [[ "${existing_target}" == "${mount_point}" ]]; then
  printf 'session_volume=%s\nmount=%s\nformatted=false\n' "${volume_id}" "${mount_point}"
  exit 0
fi
[[ -z "${existing_target}" ]] || {
  printf 'error: %s is already mounted at %s\n' "${device}" "${existing_target}" >&2
  exit 1
}

formatted=false
filesystem_type="$(blkid -s TYPE -o value "${device}" 2>/dev/null || true)"
if [[ -z "${filesystem_type}" ]]; then
  mkfs.xfs -q -L "${SESSION_LABEL}" "${device}" >&2
  formatted=true
elif [[ "${filesystem_type}" != "xfs" || "$(blkid -s LABEL -o value "${device}" 2>/dev/null || true)" != "${SESSION_LABEL}" ]]; then
  printf 'error: %s holds a filesystem that is not a session volume\n' "${device}" >&2
  exit 1
fi

mkdir -p -- "${mount_point}"
mount -o noatime -- "${device}" "${mount_point}"
printf 'session_volume=%s\nmount=%s\nformatted=%s\n' "${volume_id}" "${mount_point}" "${formatted}"
