#!/usr/bin/env bash
# Verify and mount one explicitly named EBS data device.

set -Eeuo pipefail

readonly DATA_MOUNT="${SPAWNPOINT_DATA_MOUNT:-/srv/spawnpoint}"
# XFS labels are limited to 12 characters.
readonly EXPECTED_LABEL="spawnpoint"

usage() {
  cat >&2 <<'EOF'
usage: prepare-data-volume.sh <block-device> [--format-empty]

The script never formats a device unless --format-empty is present. Identify
the EBS device from its volume ID before invoking it; /dev/sdf is commonly
renamed to an NVMe device on Nitro instances.
EOF
  exit 2
}

[[ ${EUID} -eq 0 ]] || { printf 'error: run as root\n' >&2; exit 1; }
[[ $# -ge 1 && $# -le 2 ]] || usage

readonly DEVICE="$1"
readonly FORMAT_EMPTY="${2:-}"
[[ -z ${FORMAT_EMPTY} || ${FORMAT_EMPTY} == "--format-empty" ]] || usage
[[ -b ${DEVICE} ]] || { printf 'error: not a block device: %s\n' "${DEVICE}" >&2; exit 1; }

canonical_device="$(readlink -f -- "${DEVICE}")"
root_source="$(findmnt -nro SOURCE /)"
root_source="$(readlink -f -- "${root_source}")"
root_parent_name="$(lsblk -nro PKNAME "${root_source}" | head -n 1)"
root_parent=""
if [[ -n ${root_parent_name} ]]; then
  root_parent="$(readlink -f -- "/dev/${root_parent_name}")"
fi

if [[ ${canonical_device} == "${root_source}" || (-n ${root_parent} && ${canonical_device} == "${root_parent}") ]]; then
  printf 'error: refusing the root filesystem device: %s\n' "${canonical_device}" >&2
  exit 1
fi

if lsblk -nro TYPE "${canonical_device}" | tail -n +2 | grep -q .; then
  printf 'error: use the exact filesystem device, not a disk with child partitions: %s\n' "${canonical_device}" >&2
  exit 1
fi

existing_target="$(findmnt -nro TARGET --source "${canonical_device}" 2>/dev/null || true)"
if [[ -n ${existing_target} && ${existing_target} != "${DATA_MOUNT}" ]]; then
  printf 'error: %s is already mounted at %s\n' "${canonical_device}" "${existing_target}" >&2
  exit 1
fi

filesystem_type="$(blkid -s TYPE -o value "${canonical_device}" 2>/dev/null || true)"
if [[ -z ${filesystem_type} ]]; then
  if [[ ${FORMAT_EMPTY} != "--format-empty" ]]; then
    printf 'error: %s has no filesystem; inspect it, then repeat with --format-empty\n' "${canonical_device}" >&2
    exit 1
  fi
  mkfs.xfs -L "${EXPECTED_LABEL}" "${canonical_device}"
  filesystem_type=xfs
fi

filesystem_uuid="$(blkid -s UUID -o value "${canonical_device}")"
[[ -n ${filesystem_uuid} ]] || { printf 'error: filesystem UUID is missing\n' >&2; exit 1; }

install -d -m 0755 "${DATA_MOUNT}"

conflicting_fstab_entry="$(awk -v target="${DATA_MOUNT}" -v uuid="UUID=${filesystem_uuid}" \
  '$1 !~ /^#/ && $2 == target && $1 != uuid { print; exit }' /etc/fstab)"
if [[ -n ${conflicting_fstab_entry} ]]; then
  printf 'error: conflicting fstab entry for %s: %s\n' "${DATA_MOUNT}" "${conflicting_fstab_entry}" >&2
  exit 1
fi

fstab_entry="UUID=${filesystem_uuid} ${DATA_MOUNT} ${filesystem_type} defaults,nofail,x-systemd.device-timeout=30 0 2"
if ! grep -Fq "UUID=${filesystem_uuid} ${DATA_MOUNT} " /etc/fstab; then
  printf '%s\n' "${fstab_entry}" >>/etc/fstab
fi

mounted_source="$(findmnt -nro SOURCE "${DATA_MOUNT}" 2>/dev/null || true)"
if [[ -n ${mounted_source} ]]; then
  mounted_uuid="$(blkid -s UUID -o value "${mounted_source}" 2>/dev/null || true)"
  if [[ ${mounted_uuid} != "${filesystem_uuid}" ]]; then
    printf 'error: %s is already backed by a different filesystem\n' "${DATA_MOUNT}" >&2
    exit 1
  fi
else
  mount "${DATA_MOUNT}"
fi

install -d -m 0755 \
  "${DATA_MOUNT}/app" \
  "${DATA_MOUNT}/backups" \
  "${DATA_MOUNT}/system" \
  "${DATA_MOUNT}/system/zerotier-one"

printf 'result=mounted\n'
printf 'device=%s\n' "${canonical_device}"
printf 'filesystem_type=%s\n' "${filesystem_type}"
printf 'filesystem_uuid=%s\n' "${filesystem_uuid}"
printf 'mount=%s\n' "${DATA_MOUNT}"
