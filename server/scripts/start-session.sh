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

if [[ -n "${WORLD_ID:-}" && -z "${SPAWNPOINT_WORLD_CATALOG:-}" ]]; then
  configured_release_bucket="${RELEASE_BUCKET:-$(read_env_value RELEASE_BUCKET 2>/dev/null || true)}"
  catalog_output="$(RELEASE_BUCKET="${configured_release_bucket}" "${SCRIPT_DIR}/refresh-world-catalog.sh" "${WORLD_ID}")"
  export SPAWNPOINT_WORLD_CATALOG
  SPAWNPOINT_WORLD_CATALOG="$(awk -F= '$1 == "catalog" { print substr($0, index($0, "=") + 1) }' <<<"${catalog_output}")"
  [[ -n "${SPAWNPOINT_WORLD_CATALOG}" ]] || { printf 'error: world catalog refresh returned no path\n' >&2; exit 1; }
fi

# Resolve the world and its game before any host plumbing is examined: a
# session refused for what the world IS — the gate-versus-auth invariant
# (ADR-0033), or a connectivity strategy that does not exist yet — is refused
# here, not after the environment checks.
# shellcheck source=../games/_dispatch.sh
source "${SERVER_DIR}/games/_dispatch.sh"
# shellcheck source=_connectivity.sh
source "${SCRIPT_DIR}/_connectivity.sh"
resolve_game

if [[ "${WORLD_STORAGE_LAYOUT:-legacy}" == "generation" ]]; then
  export RELEASE_BUCKET="${RELEASE_BUCKET:-$(read_env_value RELEASE_BUCKET)}"
  "${SCRIPT_DIR}/reconcile-purged-worlds.sh" "${WORLD_ID}" >&2
  if [[ -n "${WORLD_RESTORE_BACKUP_KEY:-}" ]]; then
    export BACKUP_BUCKET="${BACKUP_BUCKET:-$(read_env_value BACKUP_BUCKET)}"
  fi
  "${SCRIPT_DIR}/prepare-world.sh" "${WORLD_ID}" >&2
fi

# Catalog worlds carry connectivity and a declared auth override; the env-only
# path predates the axis and is the overlay by construction.
session_connectivity="${WORLD_CONNECTIVITY:-zerotier}"
session_auth="${WORLD_AUTH:-${GAME_DEFAULT_AUTH:-none}}"
assert_connectivity_invariant "${session_auth}" "${session_connectivity}"
# Refused for what the world is, before any host plumbing is examined: a
# strategy this host cannot perform is not a missing .env or a missing tool.
case "${session_connectivity}" in
  zerotier | raw) ;;
  *)
    printf 'error: connectivity strategy %s is not implemented\n' "${session_connectivity}" >&2
    exit 1
    ;;
esac

[[ -f "${runtime_env}" ]] || {
  printf 'error: runtime environment does not exist: %s\n' "${runtime_env}" >&2
  exit 1
}
command -v jq >/dev/null 2>&1 || {
  printf 'error: jq is not installed\n' >&2
  exit 1
}

# publish(): the strategy answers with the host part of the address, and it is
# the strategy that decides what "ready to publish" means. The overlay must be
# joined and assigned before a session starts; a public address only has to
# exist, because the instance already holds it.
network_id=""
case "${session_connectivity}" in
  zerotier)
    network_id="${ZEROTIER_NETWORK_ID:-$(read_env_value ZEROTIER_NETWORK_ID)}"
    connection_host="${ZEROTIER_ADDRESS:-$(read_env_value ZEROTIER_ADDRESS)}"

    [[ "${network_id}" =~ ^[0-9a-fA-F]{16}$ ]] || {
      printf 'error: expected a 16-character ZeroTier network ID\n' >&2
      exit 1
    }
    [[ "${connection_host}" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || {
      printf 'error: expected a ZeroTier IPv4 address without a prefix length\n' >&2
      exit 1
    }
    command -v zerotier-cli >/dev/null 2>&1 || {
      printf 'error: zerotier-cli is not installed\n' >&2
      exit 1
    }

    network_json="$(zerotier-cli -j listnetworks)"
    jq -e \
      --arg network_id "${network_id,,}" \
      --arg connection_host "${connection_host}" \
      'any(.[];
        (.nwid | ascii_downcase) == $network_id
        and .status == "OK"
        and any(.assignedAddresses[]?; split("/")[0] == $connection_host)
      )' >/dev/null <<<"${network_json}" || {
        printf 'error: ZeroTier network %s is not ready at %s\n' "${network_id}" "${connection_host}" >&2
        exit 1
      }
    ;;
  raw)
    # The address changes with every session, so it is read now rather than
    # configured. IMDSv2 with hop_limit=1 answers the host itself and refuses a
    # container, which is the same property that keeps the instance role out of
    # a compromised game server (ADR-0033).
    connection_host="$("${SCRIPT_DIR}/read-public-address.sh")" || {
      printf 'error: this host has no public address to publish\n' >&2
      exit 1
    }
    ;;
esac

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

# Boot-time reconciliation (ADR-0030): make the mod directory match the
# desired release of this world's exact wipe before the game starts.
# A promotion made while the server was stopped lands here, on the next start.
# No pointer (exit 3) is the legitimate pre-import state and starts as before;
# any other failure refuses the start — wrong mods corrupt worlds.
world_name="${WORLD_NAME:-${WORLD_ID:-$(read_env_value WORLD_NAME 2>/dev/null || printf 'world')}}"
release_bucket="${RELEASE_BUCKET:-$(read_env_value RELEASE_BUCKET 2>/dev/null || true)}"
reconcile_status="skipped_no_bucket"
desired_release="null"
if [[ -n "${release_bucket}" ]]; then
  export RELEASE_BUCKET="${release_bucket}"
  [[ "${WORLD_GENERATION_ID:-}" =~ ^gen-[0-9a-f]{32}$ ]] || {
    printf 'error: world %s has no current wipe id\n' "${world_name}" >&2
    exit 1
  }
  if pointer_output="$("${SCRIPT_DIR}/read-release-pointer.sh" "${world_name}" "${WORLD_GENERATION_ID}")"; then
    desired_release="$(awk -F= '$1 == "desired_release" { print $2 }' <<<"${pointer_output}")"
    payload_dir="${SERVER_DIR}/releases/${desired_release}"
    "${SCRIPT_DIR}/download-release.sh" "${desired_release}" "${payload_dir}" >&2
    if [[ "${WORLD_STORAGE_LAYOUT}" == "generation" ]]; then
      "${SCRIPT_DIR}/reconcile-release.sh" "${payload_dir}/manifest.json" \
        "${SPAWNPOINT_WORLD_MODS_DIRECTORY}" >&2
    elif [[ "${GAME_ID}" == "minecraft" ]]; then
      "${SCRIPT_DIR}/reconcile-release.sh" "${payload_dir}/manifest.json" >&2
    else
      "${SCRIPT_DIR}/reconcile-release.sh" "${payload_dir}/manifest.json" \
        "${SPAWNPOINT_WORLD_MODS_DIRECTORY:-${SERVER_DIR}/games/${GAME_ID}/data/mods}" >&2
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
if [[ -n "${network_id}" ]]; then
  printf 'zerotier_network=%s\n' "${network_id,,}"
fi
# The address is composed, never configured: the strategy answers with the host
# part and the game answers with the port. A single configured string used to
# carry Minecraft's port for every game.
printf 'connectivity=%s\n' "${session_connectivity}"
printf 'connection_host=%s\n' "${connection_host}"
printf 'connection_address=%s\n' "${connection_host}:${GAME_CONNECT_PORT}"
printf 'world=%s\n' "${world_name}"
printf 'reconcile=%s\n' "${reconcile_status}"
printf 'desired_release=%s\n' "${desired_release}"
