#!/usr/bin/env bash

# Factorio: the first tenant after Minecraft, and the reason the adapter is
# functions rather than configuration — its player query needs a different
# transport (Source RCON spoken from the host; the image ships no in-container
# CLI), a different parser, and saves that are zip files rather than a world
# directory. The RCON password is read from the file the server itself
# generates (config/rconpw), so the module introduces no new secret.
#
# shellcheck shell=bash
# shellcheck disable=SC2034  # the GAME_* constants are the module's interface, read by _dispatch.sh consumers

GAME_COMPOSE_FILES="observability/compose.yaml:games/factorio/compose.yaml"
GAME_COMPOSE_SERVICE="factorio"
GAME_MOD_EXTENSION="zip"
GAME_LOADER_TYPE="factorio"
# The port a player types after the address the connectivity strategy publishes.
GAME_CONNECT_PORT="34197"
GAME_CONNECT_PROTOCOL="udp"
# Fail closed, and for the same reason the server needs no factorio.com
# account: a hidden server skips matchmaking entirely, so it also verifies
# nobody. Identity verification belongs to a visible, credentialed server; a
# world that runs one declares `auth: game` in the catalog (ADR-0033).
GAME_DEFAULT_AUTH="none"

FACTORIO_GAME_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
FACTORIO_DATA_DIR="${FACTORIO_DATA_DIR:-${SPAWNPOINT_WORLD_DATA_DIRECTORY:-${FACTORIO_GAME_DIR}/data}}"
FACTORIO_RCON_HOST="${FACTORIO_RCON_HOST:-127.0.0.1}"
FACTORIO_RCON_PORT="${FACTORIO_RCON_PORT:-27015}"

# The preset release, not Spawnpoint, selects the immutable container image
# that opens this save. Version metadata still has to agree with itself; the
# digest-addressed image is carried independently as runtime.image.
game_prepare_runtime() {
  local manifest="$1" version loader_version image
  version="$(jq -r 'select(.game == "factorio") | .minecraft_version // empty' "${manifest}")"
  loader_version="$(jq -r 'select(.loader.type == "factorio") | .loader.version // empty' "${manifest}")"
  image="$(jq -r '.runtime.image // empty' "${manifest}")"
  [[ "${version}" =~ ^[0-9]+\.[0-9]+(\.[0-9]+)?$ && "${loader_version}" == "${version}" ]] || {
    printf 'error: factorio release does not select one valid engine version: %s\n' "${manifest}" >&2
    return 1
  }
  [[ "${image}" =~ ^[A-Za-z0-9._/-]+(:[A-Za-z0-9._-]+)?@sha256:[0-9a-f]{64}$ ]] || {
    printf 'error: factorio release does not select a digest-addressed runtime image: %s\n' "${manifest}" >&2
    return 1
  }
  export SPAWNPOINT_GAME_IMAGE="${image}"
}

# Stop, status and idle probes are separate SSM commands. Recover the selected
# engine from the reconciled manifest instead of relying on process-local state
# left by start-session.sh.
game_prepare_installed_runtime() {
  [[ -n "${SPAWNPOINT_GAME_IMAGE:-}" ]] && return 0
  local mods_dir manifest
  mods_dir="${SPAWNPOINT_WORLD_MODS_DIRECTORY:-${FACTORIO_DATA_DIR}/mods}"
  manifest="${mods_dir}/.spawnpoint-release.json"
  [[ -f "${manifest}" && ! -L "${manifest}" ]] || {
    printf 'error: installed Factorio release manifest not found: %s\n' "${manifest}" >&2
    return 1
  }
  game_prepare_runtime "${manifest}"
}

game_query_players_raw() {
  local password_file="${FACTORIO_DATA_DIR}/config/rconpw"
  [[ -s "${password_file}" ]] || {
    printf 'error: factorio rcon password file not found: %s\n' "${password_file}" >&2
    return 1
  }
  python3 "${FACTORIO_GAME_DIR}/rcon-client.py" \
    "${FACTORIO_RCON_HOST}" "${FACTORIO_RCON_PORT}" \
    "$(head -n1 -- "${password_file}")" \
    "/players online"
}

# Readiness: the image ships no health check, so the control path is the whole
# signal — RCON answers and its reply parses. This cannot pass before the server
# has booted, because the password file is written by the server itself.
game_ready() {
  local health="$1"
  [[ "${health}" != "unhealthy" ]] || return 1
  game_query_players_raw 2>/dev/null | game_parse_player_count >/dev/null 2>&1
}

# "Online players (N):" followed by one indented name per line.
game_parse_player_count() {
  local response count
  response="$(cat)"
  count="$(sed -nE 's/^Online players \(([0-9]+)\).*$/\1/p' <<<"${response}")"
  [[ "${count}" =~ ^[0-9]+$ ]] || return 1
  printf '%s\n' "${count}"
}

# A Factorio save is saves/<name>.zip; archive the directory whole so autosave
# rotations travel together.
game_save_paths() {
  local data_dir="$1" _world_name="$2"
  [[ -d "${data_dir}/saves" ]] || return 0
  printf 'saves\0'
}

game_save_sentinel() {
  local data_dir="$1" _world_name="$2"
  [[ -n "$(find "${data_dir}/saves" -maxdepth 1 -type f -name '*.zip' -print -quit 2>/dev/null)" ]]
}

game_archive_sentinel_regex() {
  local _world_name="$1"
  printf '^saves/[^/]+\\.zip$'
}

# Factorio reads mods/mod-list.json to know what is enabled. The file is a
# pure function of the mod directory's contents (<name>_<version>.zip), so it
# is generated at session preparation rather than carried in release payloads
# — the manifest schema stays mods-only (ADR-0034's open question, answered).
game_prepare_session() {
  local mods_dir="${FACTORIO_DATA_DIR}/mods"
  mkdir -p -- "${mods_dir}"
  local names=()
  local zip name
  while IFS= read -r -d '' zip; do
    name="$(basename -- "${zip}")"
    [[ "${name}" =~ ^(.+)_[0-9]+(\.[0-9]+)*\.zip$ ]] || continue
    names+=("${BASH_REMATCH[1]}")
  done < <(find "${mods_dir}" -maxdepth 1 -type f -name '*.zip' -print0 | sort -z)

  {
    printf '{\n  "mods": [\n'
    printf '    { "name": "base", "enabled": true }'
    for name in "${names[@]}"; do
      printf ',\n    { "name": "%s", "enabled": true }' "${name}"
    done
    printf '\n  ]\n}\n'
  } >"${mods_dir}/mod-list.json"
}
