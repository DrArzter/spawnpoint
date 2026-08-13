#!/usr/bin/env bash
# Install ZeroTier only after its state directory can live on the data volume.

set -Eeuo pipefail

readonly DATA_MOUNT="${SPAWNPOINT_DATA_MOUNT:-/srv/spawnpoint}"
readonly STATE_SOURCE="${DATA_MOUNT}/system/zerotier-one"
readonly STATE_TARGET="/var/lib/zerotier-one"

usage() {
  printf 'usage: configure-zerotier.sh <16-hex-network-id>\n' >&2
  exit 2
}

[[ ${EUID} -eq 0 ]] || { printf 'error: run as root\n' >&2; exit 1; }
[[ $# -eq 1 ]] || usage
readonly NETWORK_ID="${1,,}"
[[ ${NETWORK_ID} =~ ^[0-9a-f]{16}$ ]] || usage

mountpoint -q "${DATA_MOUNT}" || {
  printf 'error: persistent data volume is not mounted at %s\n' "${DATA_MOUNT}" >&2
  exit 1
}

if systemctl list-unit-files zerotier-one.service >/dev/null 2>&1; then
  systemctl stop zerotier-one || true
fi

install -d -m 0700 "${STATE_SOURCE}"
install -d -m 0700 "${STATE_TARGET}"

if [[ -f ${STATE_TARGET}/identity.secret ]] && ! mountpoint -q "${STATE_TARGET}"; then
  printf 'error: ZeroTier identity already exists on the root volume; refusing to hide it\n' >&2
  exit 1
fi

bind_entry="${STATE_SOURCE} ${STATE_TARGET} none bind,x-systemd.requires-mounts-for=${DATA_MOUNT} 0 0"
if ! grep -Fq "${STATE_SOURCE} ${STATE_TARGET} " /etc/fstab; then
  printf '%s\n' "${bind_entry}" >>/etc/fstab
fi
mountpoint -q "${STATE_TARGET}" || mount --bind "${STATE_SOURCE}" "${STATE_TARGET}"

if ! command -v zerotier-cli >/dev/null 2>&1; then
  installer="$(mktemp /tmp/zerotier-install.XXXXXX)"
  trap 'rm -f -- "${installer:-}"' EXIT
  curl --fail --silent --show-error --location https://install.zerotier.com -o "${installer}"
  bash "${installer}"
fi

install -d -m 0700 "${STATE_TARGET}/networks.d"
touch "${STATE_TARGET}/networks.d/${NETWORK_ID}.conf"
chmod 0600 "${STATE_TARGET}/networks.d/${NETWORK_ID}.conf"
systemctl enable zerotier-one
# The official installer starts the service before the auto-join file exists.
# A restart is therefore required on first install and harmless on retries.
systemctl restart zerotier-one

zerotier_ready=false
for _ in {1..30}; do
  if zerotier-cli info >/dev/null 2>&1; then
    zerotier_ready=true
    break
  fi
  sleep 1
done

if [[ ${zerotier_ready} != true ]]; then
  printf 'error: ZeroTier control socket did not become ready within 30 seconds\n' >&2
  exit 1
fi

printf 'result=configured\n'
printf 'network_id=%s\n' "${NETWORK_ID}"
zerotier-cli info
zerotier-cli listnetworks
