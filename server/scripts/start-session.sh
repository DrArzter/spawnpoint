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

# Resolve the world and its game before any host plumbing is examined: a
# session refused for what the world IS — the gate-versus-auth invariant
# (ADR-0033), or a connectivity strategy that does not exist yet — is refused
# here, not after the environment checks.
# shellcheck source=../games/_dispatch.sh
source "${SERVER_DIR}/games/_dispatch.sh"
# shellcheck source=_connectivity.sh
source "${SCRIPT_DIR}/_connectivity.sh"
resolve_game

# Catalog worlds carry connectivity and a declared auth override; the env-only
# path predates the axis and is the overlay by construction.
session_connectivity="${WORLD_CONNECTIVITY:-zerotier}"
session_auth="${WORLD_AUTH:-${GAME_DEFAULT_AUTH:-none}}"
assert_connectivity_invariant "${session_auth}" "${session_connectivity}"
[[ "${session_connectivity}" == "zerotier" ]] || {
  printf 'error: connectivity strategy %s is not implemented yet; the overlay is the one that exists\n' \
    "${session_connectivity}" >&2
  exit 1
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
if [[ -z "${SERVER_COMPOSE_FILES:-}" ]]; then
  compose_files=""
  IFS=':' read -r -a game_compose <<<"${GAME_COMPOSE_FILES}"
  for compose_file in "${game_compose[@]}"; do
    compose_files="${compose_files:+${compose_files}:}${SERVER_DIR}/${compose_file}"
  done
  export SERVER_COMPOSE_FILES="${compose_files}"
fi
export SERVER_COMPOSE_SERVICE="${SERVER_COMPOSE_SERVICE:-${GAME_COMPOSE_SERVICE}}"

# Boot-time reconciliation (ADR-0030): if this world has a release pointer,
# make the mod directory match its desired release before Minecraft starts.
# A promotion made while the server was stopped lands here, on the next start.
# No pointer (exit 3) is the legitimate pre-import state and starts as before;
# any other failure refuses the start — wrong mods corrupt worlds.
world_name="${WORLD_NAME:-${WORLD_ID:-$(read_env_value WORLD_NAME 2>/dev/null || printf 'world')}}"
release_bucket="${RELEASE_BUCKET:-$(read_env_value RELEASE_BUCKET 2>/dev/null || true)}"
reconcile_status="skipped_no_bucket"
desired_release="null"
if [[ -n "${release_bucket}" ]]; then
  export RELEASE_BUCKET="${release_bucket}"
  if pointer_output="$(WORLD_NAME="${world_name}" "${SCRIPT_DIR}/read-release-pointer.sh" "${world_name}")"; then
    desired_release="$(awk -F= '$1 == "desired_release" { print $2 }' <<<"${pointer_output}")"
    payload_dir="${SERVER_DIR}/releases/${desired_release}"
    "${SCRIPT_DIR}/download-release.sh" "${desired_release}" "${payload_dir}" >&2
    if [[ "${GAME_ID}" == "minecraft" ]]; then
      "${SCRIPT_DIR}/reconcile-release.sh" "${payload_dir}/manifest.json" >&2
    else
      "${SCRIPT_DIR}/reconcile-release.sh" "${payload_dir}/manifest.json" \
        "${SERVER_DIR}/games/${GAME_ID}/data/mods" >&2
    fi
    reconcile_status="applied"
  elif [[ $? -eq 3 ]]; then
    reconcile_status="skipped_no_pointer"
  else
    printf 'error: could not read the release pointer for world %s\n' "${world_name}" >&2
    exit 1
  fi
fi

# A game may need last-mile files derived from the reconciled directory —
# factorio's mod-list.json is generated here, never carried in payloads.
if declare -F game_prepare_session >/dev/null; then
  game_prepare_session
fi

"${SCRIPT_DIR}/start.sh"
printf 'zerotier_network=%s\n' "${network_id,,}"
printf 'connection_address=%s\n' "${expected_address}"
printf 'world=%s\n' "${world_name}"
printf 'reconcile=%s\n' "${reconcile_status}"
printf 'desired_release=%s\n' "${desired_release}"
