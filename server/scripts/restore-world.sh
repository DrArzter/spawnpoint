#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_common.sh
source "${SCRIPT_DIR}/_common.sh"

archive="${1:-}"
destination="${2:-}"
mods_destination="${3:-}"
world_name="${WORLD_NAME:-world}"

# Restore is game-aware for the same reason verification and archiving are:
# the durable save sentinel is not a Minecraft level.dat for every tenant.
# shellcheck source=../games/_dispatch.sh
source "$(cd -- "${SCRIPT_DIR}/.." && pwd)/games/_dispatch.sh"
resolve_game

[[ -n "${archive}" && -n "${destination}" ]] ||
  die "usage: restore-world.sh <archive.tar.zst> <new-data-directory> [mods-directory]"

archive="$(realpath -m -- "${archive}")"
destination="$(realpath -m -- "${destination}")"
live_data_dir="$(realpath -m -- "${SERVER_DIR}/data")"

[[ "${destination}" != "${live_data_dir}" ]] || die "refusing to restore over the live data directory"

if [[ -e "${destination}" ]]; then
  [[ -d "${destination}" ]] || die "restore destination exists and is not a directory: ${destination}"
  [[ -z "$(find "${destination}" -mindepth 1 -maxdepth 1 -print -quit)" ]] || die "restore destination must be empty: ${destination}"
fi

"${SCRIPT_DIR}/verify-archive.sh" "${archive}" >/dev/null

# The mod data folders (mods-data/<folder>/, ADR-0010) go back into a mods
# directory, never into the data directory. An archive made before them has
# none and restores exactly as before.
mapfile -t mod_data_folders < <(tar --list --zstd --file "${archive}" | sed -nE 's,^mods-data/([^/]+)/.*$,\1,p' | sort -u)
if (( ${#mod_data_folders[@]} > 0 )); then
  [[ -n "${mods_destination}" ]] ||
    die "the archive holds mod data (mods-data/); name the mods directory to restore it into as the third argument"
  mods_destination="$(realpath -m -- "${mods_destination}")"
  [[ "${mods_destination}" != "$(realpath -m -- "${SERVER_DIR}/mods")" ]] ||
    die "refusing to restore mod data into the live mods directory"
  [[ -z "${SPAWNPOINT_WORLD_MODS_DIRECTORY:-}" || "${mods_destination}" != "$(realpath -m -- "${SPAWNPOINT_WORLD_MODS_DIRECTORY}")" ]] ||
    die "refusing to restore mod data into the live mods directory of the world"
  [[ ! -L "${mods_destination}" && ( ! -e "${mods_destination}" || -d "${mods_destination}" ) ]] ||
    die "mods destination is not a directory: ${mods_destination}"
  # Two folders of one name are never merged: a restore that would do so stops
  # before it writes anything.
  for folder in "${mod_data_folders[@]}"; do
    [[ ! -e "${mods_destination}/${folder}" && ! -L "${mods_destination}/${folder}" ]] ||
      die "mods destination already holds ${folder}; refusing to merge mod data into it: ${mods_destination}"
  done
fi

mkdir -p -- "${destination}"
tar --extract --zstd --file "${archive}" --directory "${destination}" --no-same-owner --no-same-permissions \
  --anchored --exclude=mods-data

if (( ${#mod_data_folders[@]} > 0 )); then
  mkdir -p -- "${mods_destination}"
  tar --extract --zstd --file "${archive}" --directory "${mods_destination}" --no-same-owner --no-same-permissions \
    --keep-old-files --strip-components=1 mods-data
fi

game_save_sentinel "${destination}" "${world_name}" || die "restore completed without a recognisable ${GAME_ID} save"

printf 'result=restored\n'
printf 'archive=%s\n' "${archive}"
printf 'destination=%s\n' "${destination}"
printf 'restored_bytes=%s\n' "$(du --summarize --bytes -- "${destination}" | awk '{print $1}')"
printf 'mod_data_directories=%s\n' "${#mod_data_folders[@]}"
