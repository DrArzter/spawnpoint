#!/usr/bin/env bash

# Copy one stopped legacy runtime into an already-registered first wipe.
# The legacy directories remain untouched. A fully verified staging tree is
# renamed into place only after data and mods match byte-for-byte.

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_worlds.sh
source "${SCRIPT_DIR}/_worlds.sh"

[[ $# -eq 3 ]] || {
  printf 'usage: %s <world-id> <legacy-data-directory> <legacy-mods-directory>\n' "$0" >&2
  exit 2
}

world_id="$1"
legacy_data="$(realpath -e -- "$2")"
legacy_mods="$(realpath -e -- "$3")"
load_world "${world_id}"
require_world_command flock
require_world_command jq
require_world_command rsync

[[ "${WORLD_STORAGE_LAYOUT}" == "generation" ]] || {
  printf 'error: world is not generation-managed: %s\n' "${world_id}" >&2
  exit 1
}
for source in "${legacy_data}" "${legacy_mods}"; do
  [[ -d "${source}" && ! -L "${source}" ]] || {
    printf 'error: legacy source is not a regular directory: %s\n' "${source}" >&2
    exit 1
  }
done

mkdir -p -- "${WORLDS_DIRECTORY}"
[[ -d "${WORLDS_DIRECTORY}" && ! -L "${WORLDS_DIRECTORY}" ]] || {
  printf 'error: worlds storage root is unsafe\n' >&2
  exit 1
}
case "${legacy_data}/" in "${WORLDS_DIRECTORY}/"*) printf 'error: legacy data is inside the destination root\n' >&2; exit 1;; esac
case "${legacy_mods}/" in "${WORLDS_DIRECTORY}/"*) printf 'error: legacy mods are inside the destination root\n' >&2; exit 1;; esac

verify_copy() {
  local source="$1" destination="$2" difference
  difference="$(rsync -ani --checksum --delete --omit-dir-times -- "${source}/" "${destination}/")"
  [[ -z "${difference}" ]]
}

exec 9>"${WORLDS_DIRECTORY}/.spawnpoint-worlds.lock"
flock -n 9 || {
  printf 'error: another operation is changing world storage\n' >&2
  exit 1
}

if [[ -e "${WORLD_DIRECTORY}" || -L "${WORLD_DIRECTORY}" ]]; then
  [[ -d "${WORLD_DIRECTORY}" && ! -L "${WORLD_DIRECTORY}" ]] || {
    printf 'error: destination is unsafe: %s\n' "${WORLD_DIRECTORY}" >&2
    exit 1
  }
  [[ -f "${WORLD_DIRECTORY}/.spawnpoint-legacy-adoption.json" ]] &&
    verify_copy "${legacy_data}" "${WORLD_DATA_DIRECTORY}" &&
    verify_copy "${legacy_mods}" "${WORLD_MODS_DIRECTORY}" || {
      printf 'error: existing first wipe does not match the legacy runtime\n' >&2
      exit 1
    }
  printf 'result=already_adopted\n'
  exit 0
fi

stage_worlds="$(mktemp -d "${WORLDS_DIRECTORY}/.legacy-adoption.${world_id}.XXXXXXXX")"
cleanup() {
  [[ "${stage_worlds:-}" == "${WORLDS_DIRECTORY}/.legacy-adoption.${world_id}."* ]] && rm -rf -- "${stage_worlds}"
}
trap cleanup EXIT

SPAWNPOINT_WORLDS_DIRECTORY="${stage_worlds}" \
  "${SCRIPT_DIR}/prepare-world.sh" "${world_id}" >/dev/null
stage_generation="${stage_worlds}/${world_id}/generations/${WORLD_GENERATION_ID}"
rsync -a --delete --omit-dir-times -- "${legacy_data}/" "${stage_generation}/data/"
rsync -a --delete --omit-dir-times -- "${legacy_mods}/" "${stage_generation}/mods/"
verify_copy "${legacy_data}" "${stage_generation}/data" || { printf 'error: copied data verification failed\n' >&2; exit 1; }
verify_copy "${legacy_mods}" "${stage_generation}/mods" || { printf 'error: copied mods verification failed\n' >&2; exit 1; }
jq -n --arg data "${legacy_data}" --arg mods "${legacy_mods}" \
  '{schema_version: 1, source: {kind: "legacy_runtime", data_directory: $data, mods_directory: $mods}}' \
  >"${stage_generation}/.spawnpoint-legacy-adoption.json"

generations_root="$(dirname -- "${WORLD_DIRECTORY}")"
mkdir -p -- "${generations_root}"
[[ ! -L "$(dirname -- "${generations_root}")" && ! -L "${generations_root}" ]] || {
  printf 'error: generation destination contains a symbolic link\n' >&2
  exit 1
}
mv -- "${stage_generation}" "${WORLD_DIRECTORY}"
printf 'result=adopted\nworld_id=%s\ngeneration_id=%s\n' "${world_id}" "${WORLD_GENERATION_ID}"
