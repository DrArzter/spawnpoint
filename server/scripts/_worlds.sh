#!/usr/bin/env bash

set -Eeuo pipefail

WORLD_SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
WORLD_SERVER_DIR="$(cd -- "${WORLD_SCRIPT_DIR}/.." && pwd)"
WORLD_CATALOG="$(realpath -e -- "${SPAWNPOINT_WORLD_CATALOG:-${WORLD_SERVER_DIR}/worlds/catalog.json}")"
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
      ((.game // "minecraft") | type == "string" and test("^[a-z0-9][a-z0-9-]{0,31}$"))
    ) and
    (([.worlds[].id] | unique | length) == (.worlds | length))
  ' "${WORLD_CATALOG}" >/dev/null || {
    printf 'error: invalid world catalog: %s\n' "${WORLD_CATALOG}" >&2
    exit 1
  }
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
  WORLD_PROFILE_REPOSITORY="$(jq -r '.profile_source.repository' "${WORLD_CATALOG}")"
  WORLD_PROFILE_COMMIT="$(jq -r '.profile_source.commit' "${WORLD_CATALOG}")"
  WORLD_DIRECTORY="$(realpath -m -- "${WORLDS_DIRECTORY}/${WORLD_ID}")"
  WORLD_DATA_DIRECTORY="${WORLD_DIRECTORY}/data"
  WORLD_MODS_DIRECTORY="${WORLD_DIRECTORY}/mods"

  [[ "$(dirname -- "${WORLD_DIRECTORY}")" == "${WORLDS_DIRECTORY}" ]] || {
    printf 'error: resolved world directory escaped storage root\n' >&2
    exit 1
  }
}
