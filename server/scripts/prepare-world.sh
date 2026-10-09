#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_worlds.sh
source "${SCRIPT_DIR}/_worlds.sh"
# shellcheck source=_s3.sh
source "${SCRIPT_DIR}/_s3.sh"

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

# S3 is a world's home between sessions (ADR-0048): the newest archive of the
# current wipe is the world. A launched host is created empty for a session and
# terminated after it, and the world may have run on another host since this
# one last held it. A copy here stands for the world only when it is that
# archive, or when the wipe has none yet. A listing that fails refuses the
# start: an empty world must never stand in for one S3 could not answer for.
resume_key=""
if [[ "${WORLD_STORAGE_LAYOUT}" == "generation" && -n "${BACKUP_BUCKET:-}" ]]; then
  archive_prefix="worlds/${WORLD_ID}/archives/${WORLD_ID}-${WORLD_GENERATION_ID}-"
  listing="$(s3_cli list-objects-v2 --bucket "${BACKUP_BUCKET}" --prefix "${archive_prefix}" --output json)" || {
    printf 'error: could not list the backups of world %s; refusing to start without them\n' "${WORLD_ID}" >&2
    exit 1
  }
  [[ -n "${listing}" ]] || listing='{}'
  resume_key="$(jq -r --arg prefix "${archive_prefix}" '
    [.Contents[]?.Key | select(startswith($prefix) and test("-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{64}\\.tar\\.zst$"))] | sort | last // empty
  ' <<<"${listing}")"
fi

archive_record="${WORLD_DIRECTORY}/.spawnpoint-archive.json"
fresh=true
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
  if [[ -z "${resume_key}" ]]; then
    fresh=false
  elif [[ ! -f "${archive_record}" || -L "${archive_record}" ]]; then
    # Prepared before copies recorded their archive: it cannot say which it is.
    printf 'warning: keeping the copy of world %s on this host, which predates archive records; %s may be newer\n' "${WORLD_ID}" "${resume_key}" >&2
    fresh=false
  elif [[ "$(jq -r '.key // ""' "${archive_record}")" == "${resume_key}" ]]; then
    fresh=false
  else
    # The world ran elsewhere since this host held it. Its copy is kept aside,
    # never deleted, in case it held progress no backup has.
    superseded="${world_parent}/.${stage_prefix}.superseded"
    [[ ! -L "${superseded}" ]] || {
      printf 'error: superseded world path is a symbolic link: %s\n' "${superseded}" >&2
      exit 1
    }
    rm -rf -- "${superseded}"
    mv -T -- "${WORLD_DIRECTORY}" "${superseded}"
    printf 'warning: this host held an older copy of world %s; it is kept at %s\n' "${WORLD_ID}" "${superseded}" >&2
    printf 'superseded=%s\n' "${superseded}"
  fi
  ${fresh} || printf 'result=already_prepared\n'
fi

if ${fresh}; then
  stage="$(mktemp -d "${world_parent}/.${stage_prefix}.stage.XXXXXXXX")"
  cleanup() {
    if [[ -n "${stage:-}" && "$(dirname -- "${stage}")" == "${world_parent}" && "$(basename -- "${stage}")" == ".${stage_prefix}.stage."* ]]; then
      rm -rf -- "${stage}"
    fi
  }
  trap cleanup EXIT
  mkdir -p -- "${stage}/mods"
  # The archive the new copy is, and the checksum it must have: the newest of
  # the wipe, else the backup a restored wipe began from, else none.
  source_key=""
  source_checksum=""
  if [[ -n "${resume_key}" ]]; then
    source_key="${resume_key}"
    source_checksum="$(sed -E 's/^.*-([0-9a-f]{64})\.tar\.zst$/\1/' <<<"${resume_key}")"
  elif [[ -n "${WORLD_RESTORE_BACKUP_KEY}" ]]; then
    source_key="${WORLD_RESTORE_BACKUP_KEY}"
    source_checksum="${WORLD_RESTORE_CHECKSUM}"
  fi
  if [[ -n "${source_key}" ]]; then
    restore_archive="${stage}/restore.tar.zst"
    SPAWNPOINT_GAME="${WORLD_GAME}" WORLD_NAME="${WORLD_ID}" \
      "${SCRIPT_DIR}/download-world-backup.sh" "${source_key}" "${restore_archive}" >/dev/null
    actual_restore_checksum="$(sha256sum -- "${restore_archive}" | awk '{print $1}')"
    [[ "${actual_restore_checksum}" == "${source_checksum}" ]] || {
      printf 'error: backup %s does not match the checksum it is named or recorded with\n' "${source_key}" >&2
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
  record_world_archive "${stage}" "${source_key}" "${source_checksum}"
  mv -T -- "${stage}" "${WORLD_DIRECTORY}"
  stage=""
  trap - EXIT
  printf 'result=prepared\n'
  if [[ -n "${resume_key}" ]]; then printf 'resumed_from=%s\n' "${resume_key}"; fi
fi

printf 'world_id=%s\n' "${WORLD_ID}"
printf 'profile_id=%s\n' "${WORLD_PROFILE_ID}"
printf 'world_directory=%s\n' "${WORLD_DIRECTORY}"
