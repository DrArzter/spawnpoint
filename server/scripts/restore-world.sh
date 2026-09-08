#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_common.sh
source "${SCRIPT_DIR}/_common.sh"

archive="${1:-}"
destination="${2:-}"
world_name="${WORLD_NAME:-world}"

# Restore is game-aware for the same reason verification and archiving are:
# the durable save sentinel is not a Minecraft level.dat for every tenant.
# shellcheck source=../games/_dispatch.sh
source "$(cd -- "${SCRIPT_DIR}/.." && pwd)/games/_dispatch.sh"
resolve_game

[[ -n "${archive}" && -n "${destination}" ]] || die "usage: restore-world.sh <archive.tar.zst> <new-data-directory>"

archive="$(realpath -m -- "${archive}")"
destination="$(realpath -m -- "${destination}")"
live_data_dir="$(realpath -m -- "${SERVER_DIR}/data")"

[[ "${destination}" != "${live_data_dir}" ]] || die "refusing to restore over the live data directory"

if [[ -e "${destination}" ]]; then
  [[ -d "${destination}" ]] || die "restore destination exists and is not a directory: ${destination}"
  [[ -z "$(find "${destination}" -mindepth 1 -maxdepth 1 -print -quit)" ]] || die "restore destination must be empty: ${destination}"
else
  mkdir -p -- "${destination}"
fi

"${SCRIPT_DIR}/verify-archive.sh" "${archive}" >/dev/null

tar --extract --zstd --file "${archive}" --directory "${destination}" --no-same-owner --no-same-permissions

game_save_sentinel "${destination}" "${world_name}" || die "restore completed without a recognisable ${GAME_ID} save"

printf 'result=restored\n'
printf 'archive=%s\n' "${archive}"
printf 'destination=%s\n' "${destination}"
printf 'restored_bytes=%s\n' "$(du --summarize --bytes -- "${destination}" | awk '{print $1}')"
