#!/usr/bin/env bash
# The host's record of each session that runs from a session volume
# (ADR-0102): what a later process needs to reach the session without the
# control plane. One file per world; this is its only path builder.
# shellcheck shell=bash

SESSION_RECORD_SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SESSION_RECORDS_DIRECTORY="${SPAWNPOINT_SESSION_RECORDS_DIRECTORY:-${SESSION_RECORD_SCRIPT_DIR}/../runtime/sessions}"

session_record_path() {
  printf '%s/%s.record\n' "${SESSION_RECORDS_DIRECTORY}" "$1"
}

# world_id, slot, session_volume_id, world_catalog: snake_case key=value lines.
write_session_record() {
  local world_id="$1" slot="$2" volume_id="$3" catalog="$4" path
  path="$(session_record_path "${world_id}")"
  mkdir -p -- "${SESSION_RECORDS_DIRECTORY}"
  printf 'world_id=%s\nslot=%s\nsession_volume_id=%s\nworld_catalog=%s\n' \
    "${world_id}" "${slot}" "${volume_id}" "${catalog}" >"${path}.next"
  mv -f -- "${path}.next" "${path}"
}

remove_session_record() {
  rm -f -- "$(session_record_path "$1")"
}

# Print the value of one key of a record file.
session_record_value() {
  awk -F= -v key="$2" '$1 == key { print substr($0, index($0, "=") + 1); exit }' "$1"
}
