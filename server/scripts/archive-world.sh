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
for path in "${world_paths[@]}"; do
  # mods-data/ is the second root; ./ marks its members for the transform below.
  [[ -n "${path}" && "${path}" != -* && "${path}" != ./* && "${path}" != mods-data && "${path}" != mods-data/* ]] ||
    die "unsafe save path reported for ${world_name}: ${path}"
done

# Anchored, and * stops at a slash: plugins/*.jar must not reach
# plugins/Geyser/ext/a.jar, and libraries must not reach world/libraries.
exclude_options=()
if declare -F game_save_excludes >/dev/null; then
  mapfile -d '' save_excludes < <(game_save_excludes)
  exclude_options=(--anchored --no-wildcards-match-slash)
  for pattern in "${save_excludes[@]}"; do
    exclude_options+=("--exclude=${pattern}")
  done
fi

# Subfolders of the world's mods directory go in under mods-data/. The
# excludes cannot reach them: their names start with ./, which no anchored
# pattern matches.
mods_dir="$(realpath -m -- "${SERVER_MODS_DIR:-$(dirname -- "${data_dir}")/mods}")"
mod_data_paths=()
if declare -F game_mod_data_paths >/dev/null; then
  mapfile -d '' mod_data_paths < <(game_mod_data_paths "${mods_dir}")
fi
mod_data_options=()
if (( ${#mod_data_paths[@]} > 0 )); then
  mod_data_options=(--directory "${mods_dir}" --transform 's,^\./,mods-data/,S')
  for path in "${mod_data_paths[@]}"; do
    [[ -n "${path}" && "${path}" != */* && "${path}" != . && "${path}" != .. ]] ||
      die "unsafe mod data folder in ${mods_dir}: ${path}"
    mod_data_options+=("./${path}")
  done
fi

temporary_archive="$(mktemp --tmpdir="$(dirname -- "${archive}")" '.world-archive.XXXXXX.tar.zst')"
cleanup() {
  rm -f -- "${temporary_archive}"
}
trap cleanup EXIT

# No -- before the names: the mods-data part needs its own --directory. The
# check above refuses a save path that starts with -. Both directories are
# absolute, because tar resolves a relative one from the one before.
tar --create --zstd --file "${temporary_archive}" "${exclude_options[@]}" --directory "$(realpath -e -- "${data_dir}")" \
  "${world_paths[@]}" "${mod_data_options[@]}"

mv -- "${temporary_archive}" "${archive}"
digest="$(sha256sum -- "${archive}" | awk '{print $1}')"
printf '%s  %s\n' "${digest}" "$(basename -- "${archive}")" >"${archive}.sha256"

"${SCRIPT_DIR}/verify-archive.sh" "${archive}" >/dev/null

printf 'result=archived\n'
printf 'archive=%s\n' "${archive}"
printf 'checksum=%s\n' "${digest}"
printf 'archive_bytes=%s\n' "$(stat --format '%s' -- "${archive}")"
printf 'world_directories=%s\n' "${#world_paths[@]}"
printf 'mod_data_directories=%s\n' "${#mod_data_paths[@]}"
