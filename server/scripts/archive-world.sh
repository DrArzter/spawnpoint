#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SERVER_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
# shellcheck source=../games/_dispatch.sh
source "${SERVER_ROOT}/games/_dispatch.sh"
resolve_game
configure_game_compose
# shellcheck source=_common.sh
source "${SCRIPT_DIR}/_common.sh"

data_dir="${SERVER_DATA_DIR:-${SERVER_DIR}/data}"
backup_dir="${SERVER_BACKUP_DIR:-${SERVER_DIR}/backups}"
world_name="${WORLD_NAME:-world}"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
generation_segment=""
if [[ -n "${WORLD_GENERATION_ID:-}" ]]; then
  [[ "${WORLD_GENERATION_ID}" =~ ^gen-[0-9a-f]{32}$ ]] || die "invalid WORLD_GENERATION_ID"
  generation_segment="-${WORLD_GENERATION_ID}"
fi
archive="${1:-${backup_dir}/${world_name}${generation_segment}-${timestamp}.tar.zst}"

[[ -d "${data_dir}" ]] || die "data directory does not exist: ${data_dir}"
game_save_sentinel "${data_dir}" "${world_name}" || die "no recognisable ${GAME_ID} save found in ${data_dir}"

# A fixture or restored copy outside the live data directory is safe to archive while
# the server runs. The live data directory is not: its caller must stop the game first.
if [[ "$(realpath -m -- "${data_dir}")" == "$(realpath -m -- "${SERVER_DIR}/data")" ]]; then
  state="$(container_state)"
  if [[ "${state}" == "running" ]]; then
    die "the game is running; save and stop it before archiving the live world"
  fi
fi

mkdir -p -- "$(dirname -- "${archive}")"
archive="$(realpath -m -- "${archive}")"
[[ ! -e "${archive}" ]] || die "archive already exists: ${archive}"
[[ ! -e "${archive}.sha256" ]] || die "checksum already exists: ${archive}.sha256"

mapfile -d '' world_paths < <(game_save_paths "${data_dir}" "${world_name}")
(( ${#world_paths[@]} > 0 )) || die "no save paths reported for ${world_name}"

temporary_archive="$(mktemp --tmpdir="$(dirname -- "${archive}")" '.world-archive.XXXXXX.tar.zst')"
cleanup() {
  rm -f -- "${temporary_archive}"
}
trap cleanup EXIT

tar --create --zstd --file "${temporary_archive}" --directory "${data_dir}" -- "${world_paths[@]}"

mv -- "${temporary_archive}" "${archive}"
digest="$(sha256sum -- "${archive}" | awk '{print $1}')"
printf '%s  %s\n' "${digest}" "$(basename -- "${archive}")" >"${archive}.sha256"

"${SCRIPT_DIR}/verify-archive.sh" "${archive}" >/dev/null

printf 'result=archived\n'
printf 'archive=%s\n' "${archive}"
printf 'checksum=%s\n' "${digest}"
printf 'archive_bytes=%s\n' "$(stat --format '%s' -- "${archive}")"
printf 'world_directories=%s\n' "${#world_paths[@]}"
