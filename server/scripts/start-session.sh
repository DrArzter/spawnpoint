#!/usr/bin/env bash

set -Eeuo pipefail

# SESSION_FORMAT=json makes the summary one JSON document on stdout and moves
# everything else to stderr, so a machine can States.StringToJson the whole of
# stdout with no position and no order to depend on — the key=value trap in
# workflows/README.md. The default stays the key=value stream people read.
session_format="${SESSION_FORMAT:-text}"
case "${session_format}" in
  text | json) ;;
  *)
    printf 'error: SESSION_FORMAT must be text or json, not %s\n' "${session_format}" >&2
    exit 1
    ;;
esac
exec 3>&1
if [[ "${session_format}" == "json" ]]; then
  exec 1>&2
fi

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
configure_game_compose

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
load_connectivity "${session_connectivity}"
enabled_connectivity="${SPAWNPOINT_ENABLED_CONNECTIVITY:-$(read_env_value SPAWNPOINT_ENABLED_CONNECTIVITY 2>/dev/null || true)}"
if [[ -n "${enabled_connectivity}" && ",${enabled_connectivity}," != *",${session_connectivity},"* ]]; then
  printf 'error: connectivity strategy %s is not enabled on this host\n' "${session_connectivity}" >&2
  exit 1
fi

[[ -f "${runtime_env}" ]] || {
  printf 'error: runtime environment does not exist: %s\n' "${runtime_env}" >&2
  exit 1
}
command -v jq >/dev/null 2>&1 || {
  printf 'error: jq is not installed\n' >&2
  exit 1
}

# The adapter prepares its address before the game starts, but publishes it
# only after start.sh has proved readiness. A failed start cannot leave DNS
# pointing at a server that never came up.
CONNECTIVITY_NETWORK_ID=""
connectivity_prepare
connection_host="${CONNECTIVITY_HOST}"

export SERVER_PROJECT_DIRECTORY="${SERVER_DIR}"

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
    payload_dir="${SERVER_DIR}/releases/${GAME_ID}/${WORLD_PROFILE_ID}/${desired_release}"
    "${SCRIPT_DIR}/download-release.sh" "${GAME_ID}" "${WORLD_PROFILE_ID}" "${desired_release}" "${payload_dir}" >&2
    if [[ "${WORLD_STORAGE_LAYOUT}" == "generation" ]]; then
      "${SCRIPT_DIR}/reconcile-release.sh" "${payload_dir}/manifest.json" \
        "${SPAWNPOINT_WORLD_MODS_DIRECTORY}" >&2
    elif [[ "${GAME_ID}" == "minecraft" ]]; then
      "${SCRIPT_DIR}/reconcile-release.sh" "${payload_dir}/manifest.json" >&2
    else
      "${SCRIPT_DIR}/reconcile-release.sh" "${payload_dir}/manifest.json" \
        "${SPAWNPOINT_WORLD_MODS_DIRECTORY:-${SERVER_DIR}/games/${GAME_ID}/data/mods}" >&2
    fi
    if declare -F game_prepare_runtime >/dev/null; then
      game_prepare_runtime "${payload_dir}/manifest.json"
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

# A placed session is scraped by the host's own tier, which must exist before
# the session's exporter can join its network (ADR-0054, phase 9). An unplaced
# session carries the tier inside its own project, as it always has.
if [[ -n "${SPAWNPOINT_SLOT:-}" ]]; then
  "${SCRIPT_DIR}/ensure-host-observability.sh" >&2
fi

"${SCRIPT_DIR}/start.sh"
if ! connectivity_publish; then
  printf 'error: could not publish the session address; stopping the game\n' >&2
  "${SCRIPT_DIR}/stop.sh" || printf 'warning: could not stop game after publication failure\n' >&2
  exit 1
fi

# The summary is what the machine carries back to whoever asked. The address in
# it is composed, never configured: the strategy answers with the host part and
# the game with the port. A single configured string used to carry Minecraft's
# port for every game — and a caller-supplied address could never be right for
# a strategy whose address does not exist before the instance starts.
if [[ "${session_format}" == "json" ]]; then
  jq -cn \
    --arg connectivity "${session_connectivity}" \
    --arg connection_host "${connection_host}" \
    --arg connection_address "${connection_host}:${SPAWNPOINT_CONNECT_PORT:-${GAME_CONNECT_PORT}}" \
    --arg world "${world_name}" \
    --arg reconcile "${reconcile_status}" \
    --arg desired_release "${desired_release}" \
    --arg zerotier_network "${CONNECTIVITY_NETWORK_ID,,}" \
    '{
      connectivity: $connectivity,
      connection_host: $connection_host,
      connection_address: $connection_address,
      world: $world,
      reconcile: $reconcile,
      desired_release: (if $desired_release == "null" then null else $desired_release end)
    } + (if $zerotier_network == "" then {} else {zerotier_network: $zerotier_network} end)' >&3
else
  {
    if [[ -n "${CONNECTIVITY_NETWORK_ID}" ]]; then
      printf 'zerotier_network=%s\n' "${CONNECTIVITY_NETWORK_ID,,}"
    fi
    printf 'connectivity=%s\n' "${session_connectivity}"
    printf 'connection_host=%s\n' "${connection_host}"
    printf 'connection_address=%s\n' "${connection_host}:${SPAWNPOINT_CONNECT_PORT:-${GAME_CONNECT_PORT}}"
    printf 'world=%s\n' "${world_name}"
    printf 'reconcile=%s\n' "${reconcile_status}"
    printf 'desired_release=%s\n' "${desired_release}"
  } >&3
fi
