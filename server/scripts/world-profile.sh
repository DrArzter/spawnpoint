#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_worlds.sh
source "${SCRIPT_DIR}/_worlds.sh"

[[ $# -eq 1 ]] || {
  printf 'usage: %s <world-id>\n' "$0" >&2
  exit 2
}

load_world "$1"

printf 'world_id=%s\n' "${WORLD_ID}"
printf 'display_name=%s\n' "${WORLD_DISPLAY_NAME}"
printf 'profile_id=%s\n' "${WORLD_PROFILE_ID}"
printf 'profile_repository=%s\n' "${WORLD_PROFILE_REPOSITORY}"
printf 'profile_commit=%s\n' "${WORLD_PROFILE_COMMIT}"
printf 'world_directory=%s\n' "${WORLD_DIRECTORY}"
printf 'data_directory=%s\n' "${WORLD_DATA_DIRECTORY}"
printf 'mods_directory=%s\n' "${WORLD_MODS_DIRECTORY}"
