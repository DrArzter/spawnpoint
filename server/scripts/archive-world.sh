#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_common.sh
source "${SCRIPT_DIR}/_common.sh"

data_dir="${SERVER_DATA_DIR:-${SERVER_DIR}/data}"
backup_dir="${SERVER_BACKUP_DIR:-${SERVER_DIR}/backups}"
world_name="${WORLD_NAME:-world}"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
archive="${1:-${backup_dir}/${world_name}-${timestamp}.tar.zst}"

[[ -d "${data_dir}" ]] || die "data directory does not exist: ${data_dir}"
[[ -f "${data_dir}/${world_name}/level.dat" ]] || die "expected world metadata not found: ${data_dir}/${world_name}/level.dat"

# A fixture or restored copy outside the live data directory is safe to archive while
# the server runs. The live data directory is not: its caller must stop Minecraft first.
if [[ "$(realpath -m -- "${data_dir}")" == "$(realpath -m -- "${SERVER_DIR}/data")" ]]; then
  state="$(container_state)"
  if [[ "${state}" == "running" ]]; then
    die "Minecraft is running; save and stop it before archiving the live world"
  fi
fi

mkdir -p -- "$(dirname -- "${archive}")"
archive="$(realpath -m -- "${archive}")"
[[ ! -e "${archive}" ]] || die "archive already exists: ${archive}"
[[ ! -e "${archive}.sha256" ]] || die "checksum already exists: ${archive}.sha256"

mapfile -d '' world_paths < <(
  find "${data_dir}" -mindepth 1 -maxdepth 1 -type d -name "${world_name}*" -printf '%f\0' | sort -z
)
(( ${#world_paths[@]} > 0 )) || die "no world directories found for ${world_name}"

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
