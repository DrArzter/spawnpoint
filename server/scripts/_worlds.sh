#!/usr/bin/env bash
# shellcheck disable=SC2034  # the WORLD_* variables are this library's interface, read by its sourcers

set -Eeuo pipefail

WORLD_SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
WORLD_SERVER_DIR="$(cd -- "${WORLD_SCRIPT_DIR}/.." && pwd)"

# shellcheck source=_connectivity.sh
source "${WORLD_SCRIPT_DIR}/_connectivity.sh"
default_world_catalog="${WORLD_SERVER_DIR}/worlds/catalog.json"
[[ ! -f "${WORLD_SERVER_DIR}/runtime/world-catalog.json" ]] || default_world_catalog="${WORLD_SERVER_DIR}/runtime/world-catalog.json"
WORLD_CATALOG="$(realpath -e -- "${SPAWNPOINT_WORLD_CATALOG:-${default_world_catalog}}")"
WORLDS_DIRECTORY="$(realpath -m -- "${SPAWNPOINT_WORLDS_DIRECTORY:-${WORLD_SERVER_DIR}/runtime/worlds}")"

require_world_command() {
  command -v "$1" >/dev/null 2>&1 || {
    printf 'error: required command not found: %s\n' "$1" >&2
    exit 1
  }
}

validate_world_catalog() {
  require_world_command jq
  jq -e '
    .schema_version == 1 and
    (.profile_source.repository | type == "string" and length > 0) and
    (.profile_source.commit | type == "string" and test("^[0-9a-f]{40}$")) and
    (.worlds | type == "array" and length > 0) and
    all(.worlds[];
      (.id | type == "string" and test("^[a-z0-9][a-z0-9-]{0,31}$")) and
      (.display_name | type == "string" and length > 0) and
      (.profile_id | type == "string" and test("^[a-z0-9][a-z0-9-]{0,31}$")) and
      ((.game // "minecraft") | type == "string" and test("^[a-z0-9][a-z0-9-]{0,31}$")) and
      ((.host // "primary") | type == "string" and test("^[a-z0-9][a-z0-9-]{0,31}$")) and
      ((has("profile_source") | not) or (
        (.profile_source.repository | type == "string" and length > 0) and
        (.profile_source.commit | type == "string" and test("^[0-9a-f]{40}$"))
      )) and
      ((.connectivity // "zerotier") | IN("zerotier", "raw", "route53")) and
      ((has("auth") | not) or (.auth | IN("none", "game", "external")))
      and ((.storage_layout // "legacy") | IN("legacy", "generation"))
      and (if (.storage_layout // "legacy") == "generation" then
        (.generation_id | type == "string" and test("^gen-[0-9a-f]{32}$")) and
        (.release | type == "string" and test("^[0-9]+\\.[0-9]+$")) and
        ((has("restore") | not) or (
          (.restore.backup_key | type == "string" and test("^worlds/[a-z0-9][a-z0-9-]{0,31}/archives/[A-Za-z0-9._-]+\\.tar\\.zst$")) and
          (.restore.checksum | type == "string" and test("^[0-9a-f]{64}$")) and
          (.restore.source_generation_id | type == "string" and test("^gen-[0-9a-f]{32}$"))
        ))
      else true end)
    ) and
    (([.worlds[].id] | unique | length) == (.worlds | length))
  ' "${WORLD_CATALOG}" >/dev/null || {
    printf 'error: invalid world catalog: %s\n' "${WORLD_CATALOG}" >&2
    exit 1
  }

  # The gate-versus-auth invariant (ADR-0033) is a static property of the
  # catalog: an unsafe world cannot even be loaded, let alone started. The
  # declared auth wins over the game's default, so the check refuses only the
  # silent combination — an open server is a diff someone wrote, never a
  # default someone forgot.
  local entry entry_id entry_game entry_connectivity entry_auth
  while IFS= read -r entry; do
    entry_id="$(jq -r '.id' <<<"${entry}")"
    entry_game="$(jq -r '.game // "minecraft"' <<<"${entry}")"
    entry_connectivity="$(jq -r '.connectivity // "zerotier"' <<<"${entry}")"
    entry_auth="$(jq -r '.auth // empty' <<<"${entry}")"
    [[ -n "${entry_auth}" ]] || entry_auth="$(game_default_auth "${WORLD_SERVER_DIR}/games" "${entry_game}")"
    assert_connectivity_invariant "${entry_auth}" "${entry_connectivity}" || {
      printf 'error: invalid world catalog: %s (world %s)\n' "${WORLD_CATALOG}" "${entry_id}" >&2
      exit 1
    }
  done < <(jq -c '.worlds[]' "${WORLD_CATALOG}")
}

load_world() {
  local requested_world_id="$1"
  [[ "${requested_world_id}" =~ ^[a-z0-9][a-z0-9-]{0,31}$ ]] || {
    printf 'error: invalid world id: %s\n' "${requested_world_id}" >&2
    exit 1
  }

  validate_world_catalog
  local match
  match="$(jq -ce --arg id "${requested_world_id}" '.worlds[] | select(.id == $id)' "${WORLD_CATALOG}")" || {
    printf 'error: unknown world id: %s\n' "${requested_world_id}" >&2
    exit 1
  }

  WORLD_ID="${requested_world_id}"
  WORLD_DISPLAY_NAME="$(jq -r '.display_name' <<<"${match}")"
  WORLD_PROFILE_ID="$(jq -r '.profile_id' <<<"${match}")"
  # Absent means minecraft: every world that predates the game axis keeps its
  # exact pre-axis behaviour.
  WORLD_GAME="$(jq -r '.game // "minecraft"' <<<"${match}")"
  # Topology is data: which host a world runs on is a catalog fact, so the day
  # a second host exists, nothing but this value changes. "primary" is the one
  # host that exists today.
  WORLD_HOST="$(jq -r '.host // "primary"' <<<"${match}")"
  # Connectivity is a strategy (ADR-0033): which one, and the world's declared
  # auth override, are catalog data like `game` and `host`. Absent connectivity
  # means the overlay this deployment runs; absent auth means the game default.
  WORLD_CONNECTIVITY="$(jq -r '.connectivity // "zerotier"' <<<"${match}")"
  WORLD_AUTH="$(jq -r '.auth // empty' <<<"${match}")"
  # Provenance is per world when it needs to be: authoring repositories are one
  # per game, and bumping the pin for one world must not invalidate another
  # world's prepared marker. The catalog-level profile_source is the default.
  WORLD_PROFILE_REPOSITORY="$(jq -r '.profile_source.repository // empty' <<<"${match}")"
  WORLD_PROFILE_COMMIT="$(jq -r '.profile_source.commit // empty' <<<"${match}")"
  [[ -n "${WORLD_PROFILE_REPOSITORY}" ]] ||
    WORLD_PROFILE_REPOSITORY="$(jq -r '.profile_source.repository' "${WORLD_CATALOG}")"
  [[ -n "${WORLD_PROFILE_COMMIT}" ]] ||
    WORLD_PROFILE_COMMIT="$(jq -r '.profile_source.commit' "${WORLD_CATALOG}")"
  WORLD_STORAGE_LAYOUT="$(jq -r '.storage_layout // "legacy"' <<<"${match}")"
  WORLD_GENERATION_ID="$(jq -r '.generation_id // empty' <<<"${match}")"
  WORLD_RELEASE="$(jq -r '.release // empty' <<<"${match}")"
  WORLD_RESTORE_BACKUP_KEY="$(jq -r '.restore.backup_key // empty' <<<"${match}")"
  WORLD_RESTORE_CHECKSUM="$(jq -r '.restore.checksum // empty' <<<"${match}")"
  WORLD_RESTORE_SOURCE_GENERATION_ID="$(jq -r '.restore.source_generation_id // empty' <<<"${match}")"
  if [[ "${WORLD_STORAGE_LAYOUT}" == "generation" ]]; then
    WORLD_DIRECTORY="$(realpath -m -- "${WORLDS_DIRECTORY}/${WORLD_ID}/generations/${WORLD_GENERATION_ID}")"
    [[ "${WORLD_DIRECTORY}" == "${WORLDS_DIRECTORY}/${WORLD_ID}/generations/"* ]] || {
      printf 'error: resolved generation directory escaped storage root\n' >&2
      exit 1
    }
  else
    WORLD_DIRECTORY="$(realpath -m -- "${WORLDS_DIRECTORY}/${WORLD_ID}")"
  fi
  WORLD_DATA_DIRECTORY="${WORLD_DIRECTORY}/data"
  WORLD_MODS_DIRECTORY="${WORLD_DIRECTORY}/mods"
  export SPAWNPOINT_WORLD_DATA_DIRECTORY="${WORLD_DATA_DIRECTORY}"
  export SPAWNPOINT_WORLD_MODS_DIRECTORY="${WORLD_MODS_DIRECTORY}"

  [[ "${WORLD_STORAGE_LAYOUT}" == "generation" || "$(dirname -- "${WORLD_DIRECTORY}")" == "${WORLDS_DIRECTORY}" ]] || {
    printf 'error: resolved world directory escaped storage root\n' >&2
    exit 1
  }
}
