#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
runtime_env="${SERVER_ENV_FILE:-${SERVER_DIR}/.env}"

read_env_value() {
  local key="$1"
  awk -F= -v key="${key}" '$1 == key { print substr($0, index($0, "=") + 1); found = 1; exit } END { if (!found) exit 1 }' \
    "${runtime_env}"
}

# What a stop does with players online: `refuse` keeps the session running,
# `disconnect` stops it anyway. Only a caller with session.stop.force asks for
# `disconnect`.
players_policy="${SPAWNPOINT_STOP_PLAYERS:-refuse}"
[[ "${players_policy}" == "refuse" || "${players_policy}" == "disconnect" ]] || {
  printf 'error: SPAWNPOINT_STOP_PLAYERS must be refuse or disconnect, not %s\n' "${players_policy}" >&2
  exit 1
}

[[ -f "${runtime_env}" ]] || {
  printf 'error: runtime environment does not exist: %s\n' "${runtime_env}" >&2
  exit 1
}

if [[ -n "${WORLD_ID:-}" && -z "${SPAWNPOINT_WORLD_CATALOG:-}" ]]; then
  configured_release_bucket="${RELEASE_BUCKET:-$(read_env_value RELEASE_BUCKET 2>/dev/null || true)}"
  catalog_output="$(RELEASE_BUCKET="${configured_release_bucket}" "${SCRIPT_DIR}/refresh-world-catalog.sh" "${WORLD_ID}")"
  export SPAWNPOINT_WORLD_CATALOG
  SPAWNPOINT_WORLD_CATALOG="$(awk -F= '$1 == "catalog" { print substr($0, index($0, "=") + 1) }' <<<"${catalog_output}")"
  [[ -n "${SPAWNPOINT_WORLD_CATALOG}" ]] || { printf 'error: world catalog refresh returned no path\n' >&2; exit 1; }
fi

backup_bucket="${BACKUP_BUCKET:-$(read_env_value BACKUP_BUCKET)}"
aws_region="${AWS_REGION:-$(read_env_value AWS_REGION)}"
[[ "${backup_bucket}" =~ ^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$ ]] || {
  printf 'error: invalid BACKUP_BUCKET in runtime environment\n' >&2
  exit 1
}
[[ "${aws_region}" =~ ^[a-z]{2}-[a-z]+-[0-9]+$ ]] || {
  printf 'error: invalid AWS_REGION in runtime environment\n' >&2
  exit 1
}

# shellcheck source=../games/_dispatch.sh
source "${SERVER_DIR}/games/_dispatch.sh"
resolve_game
prepare_game_runtime
configure_game_compose
# shellcheck source=_connectivity.sh
source "${SCRIPT_DIR}/_connectivity.sh"
load_connectivity "${WORLD_CONNECTIVITY:-zerotier}"

if [[ "${WORLD_STORAGE_LAYOUT:-legacy}" == "generation" ]]; then
  export SERVER_DATA_DIR="${WORLD_DATA_DIRECTORY}"
  export SERVER_MODS_DIR="${WORLD_MODS_DIRECTORY}"
  export WORLD_NAME="${WORLD_ID}"
  # The backup is paired with the release that ran (ADR-0052): the wipe's
  # active release, which a promotion changes, not the release the wipe began
  # with. Without a readable pointer the archive says it carries the origin.
  WORLD_RELEASE_SOURCE="generation"
  pointer_bucket="${RELEASE_BUCKET:-$(read_env_value RELEASE_BUCKET 2>/dev/null || true)}"
  if [[ -n "${pointer_bucket}" ]] &&
    pointer_output="$(RELEASE_BUCKET="${pointer_bucket}" "${SCRIPT_DIR}/read-release-pointer.sh" "${WORLD_ID}" "${WORLD_GENERATION_ID}" 2>/dev/null)"; then
    active_release="$(awk -F= '$1 == "active_release" { print $2 }' <<<"${pointer_output}")"
    if [[ "${active_release}" =~ ^[0-9]+\.[0-9]+$ ]]; then
      WORLD_RELEASE="${active_release}"
      WORLD_RELEASE_SOURCE="active"
    fi
  fi
  # Child archive/upload processes must bind the immutable backup to the exact
  # generation it came from. The id is also encoded in the object name, so the
  # control plane can select restores without downloading world data.
  export WORLD_GENERATION_ID WORLD_RELEASE WORLD_RELEASE_SOURCE
fi

export SERVER_PROJECT_DIRECTORY="${SERVER_DIR}"

# shellcheck source=_common.sh
source "${SCRIPT_DIR}/_common.sh"

data_dir="${SERVER_DATA_DIR:-${SERVER_DIR}/data}"
world_name="${WORLD_NAME:-world}"
# Which archive the copy here is (record_world_archive). A generation keeps it
# beside its data; the legacy layout keeps it in its data directory.
if [[ "${WORLD_STORAGE_LAYOUT:-legacy}" == "generation" ]]; then
  archive_record_dir="${WORLD_DIRECTORY}"
else
  archive_record_dir="${data_dir}"
fi
archive_record="${archive_record_dir}/.spawnpoint-archive.json"

# True when the save has changed since the archive the record names, or when
# no record says which archive the copy is.
world_changed_since_upload() {
  [[ -f "${archive_record}" ]] || return 0
  [[ "$(jq -r '.key // empty' "${archive_record}")" != "" ]] || return 0
  local paths=() path changed mods_dir="${SERVER_MODS_DIR:-$(dirname -- "${data_dir}")/mods}"
  mapfile -d '' paths < <(game_save_paths "${data_dir}" "${world_name}")
  for path in "${paths[@]}"; do
    changed="$(find "${data_dir}/${path}" -newer "${archive_record}" -print -quit)"
    [[ -z "${changed}" ]] || return 0
  done
  # Mod data under mods/ is archived too (mods-data/).
  if declare -F game_mod_data_paths >/dev/null; then
    mapfile -d '' paths < <(game_mod_data_paths "${mods_dir}")
    for path in "${paths[@]}"; do
      changed="$(find "${mods_dir}/${path}" -newer "${archive_record}" -print -quit)"
      [[ -z "${changed}" ]] || return 0
    done
  fi
  return 1
}

state="$(container_state)"
if [[ "${state}" == "absent" || "${state}" == "exited" ]]; then
  # Make the whole session invariant true even if the game was stopped by a
  # previous attempt while an exporter remained alive.
  compose stop >/dev/null
  # A stopped game is not a backed-up world (ADR-0073). An earlier attempt may
  # have failed its upload, or the game may have exited alone.
  if [[ ! -d "${data_dir}" ]] || ! game_save_sentinel "${data_dir}" "${world_name}" 2>/dev/null; then
    # A wipe that began empty and never saved has nothing to lose.
    if [[ -f "${archive_record}" && "$(jq -r '.key // empty' "${archive_record}")" == "" ]]; then
      printf 'result=already_stopped_and_backed_up\n'
      exit 0
    fi
    printf 'result=world_not_on_host\n'
    printf 'error: world %s has no data on this host; its archive cannot be verified here\n' "${world_name}" >&2
    exit 6
  fi
  if ! world_changed_since_upload; then
    printf 'result=already_stopped_and_backed_up\n'
    exit 0
  fi
else
  [[ "${state}" == "running" ]] || {
    printf 'error: game container is in unexpected state: %s\n' "${state}" >&2
    exit 1
  }

  if [[ "${players_policy}" == "disconnect" ]]; then
    # The count is not a gate here, so a failed read does not block the stop.
    players="$(game_query_players_raw 2>&1)" || true
    printf 'players_disconnected=%s\n' "${players}"
  else
    players="$(game_query_players_raw)"
    player_count="$(game_parse_player_count <<<"${players}")" || {
      printf 'error: refusing to stop on an unreadable player count: %s\n' "${players}" >&2
      exit 1
    }
    [[ "${player_count}" == "0" ]] || {
      printf 'error: refusing to stop while players are online: %s\n' "${players}" >&2
      # A player raced the earlier idle observation. This is a normal refusal,
      # distinct from save, archive and upload failures.
      exit 3
    }
  fi

  "${SCRIPT_DIR}/stop.sh"
fi
archive_output="$("${SCRIPT_DIR}/archive-world.sh")"
archive="$(awk -F= '$1 == "archive" { print substr($0, index($0, "=") + 1) }' <<<"${archive_output}")"
[[ -n "${archive}" ]] || {
  printf 'error: archive-world.sh did not report an archive path\n' >&2
  exit 1
}

upload_output="$(
  BACKUP_BUCKET="${backup_bucket}" \
  AWS_REGION="${aws_region}" \
    "${SCRIPT_DIR}/upload-world-backup.sh" "${archive}"
)"

# The copy on this host is now that archive. A later start here uses it only
# while it is still the newest of the wipe (prepare-world.sh), and a later stop
# archives again only when the save has changed since.
uploaded_key="$(awk -F= '$1 == "object_key" { print substr($0, index($0, "=") + 1) }' <<<"${upload_output}")"
uploaded_checksum="$(awk -F= '$1 == "checksum" { print substr($0, index($0, "=") + 1) }' <<<"${upload_output}")"
if ! declare -F record_world_archive >/dev/null; then
  # No WORLD_ID, so no catalog: the next stop here archives again.
  :
elif [[ -n "${uploaded_key}" && -n "${uploaded_checksum}" ]]; then
  record_world_archive "${archive_record_dir}" "${uploaded_key}" "${uploaded_checksum}"
else
  # The backup is safe in S3; only the shortcut for the next start or stop is lost.
  printf 'warning: upload reported no key; the next start or stop here will not trust the local copy\n' >&2
fi

# The backup holds its release (ADR-0080). The holder needs the upload's version
# id, so it is written right after the upload. A failure never loses or fails the
# backup: the archive stays and the reconciler reports the missing holder.
backup_version="$(awk -F= '$1 == "version_id" { print substr($0, index($0, "=") + 1) }' <<<"${upload_output}")"
if [[ -n "${WORLD_GENERATION_ID:-}" && -n "${WORLD_RELEASE:-}" && -n "${GAME_ID:-}" && -n "${WORLD_PROFILE_ID:-}" && -n "${uploaded_key}" ]] &&
  { [[ -z "${backup_version}" ]] ||
    ! AWS_REGION="${aws_region}" "${SCRIPT_DIR}/hold-backup-release.sh" \
      "${GAME_ID}" "${WORLD_PROFILE_ID}" "${WORLD_RELEASE}" "${uploaded_key}" "${backup_version}" >&2; }; then
  printf 'warning: backup_holder_missing key=%s version=%s: the backup is safe; the reconciler reports the holder and register-legacy-releases.ts --apply writes it\n' \
    "${uploaded_key}" "${backup_version:-unknown}" >&2
fi

printf '%s\n' "${archive_output}"
printf '%s\n' "${upload_output}"
if ! connectivity_retract; then
  printf 'error: connectivity cleanup failed after backup; refusing final host drain\n' >&2
  exit 5
fi

# Last one out turns off the lights. The session this command was asked about is
# stopped and backed up; whether the *host* may sleep is a separate question,
# and its answer is an exit code rather than a line to parse:
#   0  nothing else is active — the instance may stop
#   4  another game on this host is still busy — leave the instance running
#   5  the answer could not be read — fail closed, and be loud about it
# With one game on the host the answer is always 0, which is why this can land
# before the topology it protects.
host_activity=0
host_output="$("${SCRIPT_DIR}/check-host-activity.sh" "${SERVER_COMPOSE_SERVICE}")" || host_activity=$?
printf '%s\n' "${host_output}"
printf 'result=session_stopped_and_backed_up\n'

if (( host_activity != 0 )); then
  printf 'error: could not determine whether other games are active on this host\n' >&2
  exit 5
fi
if ! grep -qx 'host=idle' <<<"${host_output}"; then
  exit 4
fi
