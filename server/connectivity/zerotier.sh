#!/usr/bin/env bash

connectivity_prepare() {
  CONNECTIVITY_NETWORK_ID="${ZEROTIER_NETWORK_ID:-$(read_env_value ZEROTIER_NETWORK_ID)}"
  CONNECTIVITY_HOST="${ZEROTIER_ADDRESS:-$(read_env_value ZEROTIER_ADDRESS)}"
  [[ "${CONNECTIVITY_NETWORK_ID}" =~ ^[0-9a-fA-F]{16}$ ]] || { printf 'error: invalid ZeroTier network ID\n' >&2; return 1; }
  [[ "${CONNECTIVITY_HOST}" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || { printf 'error: invalid ZeroTier address\n' >&2; return 1; }
  command -v zerotier-cli >/dev/null 2>&1 || { printf 'error: zerotier-cli is not installed\n' >&2; return 1; }
  zerotier-cli -j listnetworks | jq -e \
    --arg id "${CONNECTIVITY_NETWORK_ID,,}" --arg host "${CONNECTIVITY_HOST}" \
    'any(.[]; (.nwid | ascii_downcase) == $id and .status == "OK" and any(.assignedAddresses[]?; split("/")[0] == $host))' \
    >/dev/null || { printf 'error: ZeroTier network is not ready\n' >&2; return 1; }
  return 0
}

connectivity_publish() { return 0; }
connectivity_retract() { return 0; }
