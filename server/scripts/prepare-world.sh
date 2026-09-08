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
require_world_command flock

mkdir -p -- "${WORLDS_DIRECTORY}"
[[ -d "${WORLDS_DIRECTORY}" && ! -L "${WORLDS_DIRECTORY}" ]] || {
  printf 'error: worlds storage root must be a regular directory: %s\n' "${WORLDS_DIRECTORY}" >&2
  exit 1
}

exec 9>"${WORLDS_DIRECTORY}/.spawnpoint-worlds.lock"
flock -n 9 || {
  printf 'error: another operation is preparing a world\n' >&2
  exit 1
}

expected_marker="$(jq -cn \
  --arg world_id "${WORLD_ID}" \
  --arg profile_id "${WORLD_PROFILE_ID}" \
  --arg repository "${WORLD_PROFILE_REPOSITORY}" \
  --arg commit "${WORLD_PROFILE_COMMIT}" \
  --arg generation_id "${WORLD_GENERATION_ID}" \
  --arg release "${WORLD_RELEASE}" \
  --arg restore_key "${WORLD_RESTORE_BACKUP_KEY}" \
  --arg restore_checksum "${WORLD_RESTORE_CHECKSUM}" \
  --arg restore_generation "${WORLD_RESTORE_SOURCE_GENERATION_ID}" '
  {
    schema_version: 1,
    world_id: $world_id,
    profile: {id: $profile_id, repository: $repository, commit: $commit}
  } + (if $generation_id == "" then {} else
    {generation: {id: $generation_id, release: $release}} +
    (if $restore_key == "" then {} else {
      restore: {backup_key: $restore_key, checksum: $restore_checksum, source_generation_id: $restore_generation}
    } end)
  end)
')"

world_parent="${WORLDS_DIRECTORY}"
stage_prefix="${WORLD_ID}"
if [[ "${WORLD_STORAGE_LAYOUT}" == "generation" ]]; then
  world_root="${WORLDS_DIRECTORY}/${WORLD_ID}"
  generations_root="${world_root}/generations"
  [[ ! -L "${world_root}" && ! -L "${generations_root}" ]] || {
    printf 'error: generation storage contains a symbolic link\n' >&2
    exit 1
  }
  mkdir -p -- "${generations_root}"
  world_parent="${generations_root}"
  stage_prefix="${WORLD_GENERATION_ID}"
fi

if [[ -e "${WORLD_DIRECTORY}" || -L "${WORLD_DIRECTORY}" ]]; then
  [[ -d "${WORLD_DIRECTORY}" && ! -L "${WORLD_DIRECTORY}" ]] || {
    printf 'error: world path is not a regular directory: %s\n' "${WORLD_DIRECTORY}" >&2
    exit 1
  }
  marker="${WORLD_DIRECTORY}/.spawnpoint-world.json"
  [[ -f "${marker}" && ! -L "${marker}" ]] || {
    printf 'error: existing world directory has no trustworthy marker: %s\n' "${WORLD_DIRECTORY}" >&2
    exit 1
  }
  jq -e --argjson expected "${expected_marker}" '. == $expected' "${marker}" >/dev/null || {
    printf 'error: existing world marker does not match the catalog: %s\n' "${WORLD_ID}" >&2
    exit 1
  }
  [[ -d "${WORLD_DATA_DIRECTORY}" && ! -L "${WORLD_DATA_DIRECTORY}" ]] || {
    printf 'error: existing world data directory is missing or unsafe\n' >&2
    exit 1
  }
  [[ -d "${WORLD_MODS_DIRECTORY}" && ! -L "${WORLD_MODS_DIRECTORY}" ]] || {
    printf 'error: existing world mods directory is missing or unsafe\n' >&2
    exit 1
  }
  printf 'result=already_prepared\n'
else
  stage="$(mktemp -d "${world_parent}/.${stage_prefix}.stage.XXXXXXXX")"
  cleanup() {
    if [[ -n "${stage:-}" && "$(dirname -- "${stage}")" == "${world_parent}" && "$(basename -- "${stage}")" == ".${stage_prefix}.stage."* ]]; then
      rm -rf -- "${stage}"
    fi
  }
  trap cleanup EXIT
  mkdir -p -- "${stage}/mods"
  if [[ -n "${WORLD_RESTORE_BACKUP_KEY}" ]]; then
    restore_archive="${stage}/restore.tar.zst"
    SPAWNPOINT_GAME="${WORLD_GAME}" WORLD_NAME="${WORLD_ID}" \
      "${SCRIPT_DIR}/download-world-backup.sh" "${WORLD_RESTORE_BACKUP_KEY}" "${restore_archive}" >/dev/null
    actual_restore_checksum="$(sha256sum -- "${restore_archive}" | awk '{print $1}')"
    [[ "${actual_restore_checksum}" == "${WORLD_RESTORE_CHECKSUM}" ]] || {
      printf 'error: restored backup does not match the generation descriptor\n' >&2
      exit 1
    }
    SPAWNPOINT_GAME="${WORLD_GAME}" WORLD_NAME="${WORLD_ID}" \
      "${SCRIPT_DIR}/restore-world.sh" "${restore_archive}" "${stage}/data" >/dev/null
    rm -f -- "${restore_archive}" "${restore_archive}.sha256"
  else
    mkdir -p -- "${stage}/data"
  fi
  printf '%s\n' "${expected_marker}" >"${stage}/.spawnpoint-world.json"
  chmod 0644 "${stage}/.spawnpoint-world.json"
  mv -T -- "${stage}" "${WORLD_DIRECTORY}"
  stage=""
  trap - EXIT
  printf 'result=prepared\n'
fi

printf 'world_id=%s\n' "${WORLD_ID}"
printf 'profile_id=%s\n' "${WORLD_PROFILE_ID}"
printf 'world_directory=%s\n' "${WORLD_DIRECTORY}"
