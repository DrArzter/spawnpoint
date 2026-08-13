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

network_id="${ZEROTIER_NETWORK_ID:-$(read_env_value ZEROTIER_NETWORK_ID)}"
expected_address="${ZEROTIER_ADDRESS:-$(read_env_value ZEROTIER_ADDRESS)}"

[[ "${network_id}" =~ ^[0-9a-fA-F]{16}$ ]] || {
  printf 'error: expected a 16-character ZeroTier network ID\n' >&2
  exit 1
}
[[ "${expected_address}" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || {
  printf 'error: expected a ZeroTier IPv4 address without a prefix length\n' >&2
  exit 1
}

command -v zerotier-cli >/dev/null 2>&1 || {
  printf 'error: zerotier-cli is not installed\n' >&2
  exit 1
}
command -v jq >/dev/null 2>&1 || {
  printf 'error: jq is not installed\n' >&2
  exit 1
}

network_json="$(zerotier-cli -j listnetworks)"
jq -e \
  --arg network_id "${network_id,,}" \
  --arg expected_address "${expected_address}" \
  'any(.[];
    (.nwid | ascii_downcase) == $network_id
    and .status == "OK"
    and any(.assignedAddresses[]?; split("/")[0] == $expected_address)
  )' >/dev/null <<<"${network_json}" || {
    printf 'error: ZeroTier network %s is not ready at %s\n' "${network_id}" "${expected_address}" >&2
    exit 1
  }

export SERVER_PROJECT_DIRECTORY="${SERVER_DIR}"
export SERVER_COMPOSE_FILES="${SERVER_DIR}/compose.yaml:${SERVER_DIR}/compose.release.yaml"

"${SCRIPT_DIR}/start.sh"
printf 'zerotier_network=%s\n' "${network_id,,}"
printf 'connection_address=%s\n' "${expected_address}"
