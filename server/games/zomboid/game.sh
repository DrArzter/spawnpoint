#!/usr/bin/env bash

# Project Zomboid: the group favourite, and the game that bends the release
# model rather than the adapter. Two facts decided this module's shape, both
# checked 2026-08-27:
#
#   * The dedicated server is a separate Steam app (380870) that installs with
#     an anonymous login, and it downloads the Workshop items listed in its own
#     configuration at startup. So neither the server nor this project needs a
#     Steam account — only the players do, and they own the game.
#   * The Workshop has no versions. A mod set therefore cannot be pinned by
#     bytes the way a CurseForge file or a portal release can, so a Zomboid
#     world carries no release pointer: its mods are Workshop ids in its
#     profile, pinned by the profile's Git commit. See docs/prior-art.md.
#
# shellcheck shell=bash
# shellcheck disable=SC2034  # the GAME_* constants are the module's interface, read by _dispatch.sh consumers

GAME_COMPOSE_FILES="observability/compose.yaml:games/zomboid/compose.yaml"
GAME_COMPOSE_SERVICE="zomboid"
# No release payload exists for this game, so neither value is ever read by the
# release scripts; they are set for the contract and left honest.
GAME_MOD_EXTENSION=""
GAME_LOADER_TYPE="workshop"
# Fail closed: the server verifies Steam identities only when it runs in Steam
# mode with that verification on, and this project has not exercised that
# configuration. A world whose server does verify declares `auth: game`
# (ADR-0033, and server/games/README.md).
GAME_DEFAULT_AUTH="none"

ZOMBOID_GAME_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ZOMBOID_DATA_DIR="${ZOMBOID_DATA_DIR:-${ZOMBOID_GAME_DIR}/data}"
ZOMBOID_RCON_HOST="${ZOMBOID_RCON_HOST:-127.0.0.1}"
ZOMBOID_RCON_PORT="${ZOMBOID_RCON_PORT:-27015}"
ZOMBOID_RCON_PASSWORD_FILE="${ZOMBOID_RCON_PASSWORD_FILE:-${ZOMBOID_DATA_DIR}/rconpw}"

# Source RCON, spoken from the host with the factorio module's client — the
# protocol is the same, only the commands and their wording differ.
game_query_players_raw() {
  local password_file="${ZOMBOID_RCON_PASSWORD_FILE}"
  [[ -s "${password_file}" ]] || {
    printf 'error: zomboid rcon password file not found: %s\n' "${password_file}" >&2
    return 1
  }
  python3 "${ZOMBOID_GAME_DIR}/../factorio/rcon-client.py" \
    "${ZOMBOID_RCON_HOST}" "${ZOMBOID_RCON_PORT}" \
    "$(head -n1 -- "${password_file}")" \
    "players"
}

# "Players connected (N):" followed by one "-name" line per player.
#
# The exact wording is not documented anywhere authoritative, so the parser
# does not trust it alone: it reads the count from the header AND counts the
# listed names, and refuses unless they agree. A wrong guess therefore reports
# "unreadable" — which the probe treats as "not idle" and the stop treats as a
# refusal — rather than reporting an empty server that is not empty.
game_parse_player_count() {
  local response header_count listed
  response="$(cat)"
  header_count="$(sed -nE 's/^[[:space:]]*Players connected \(([0-9]+)\).*$/\1/p' <<<"${response}" | head -n1)"
  [[ "${header_count}" =~ ^[0-9]+$ ]] || return 1
  listed="$(grep -cE '^[[:space:]]*-' <<<"${response}" || true)"
  [[ "${listed}" == "${header_count}" ]] || return 1
  printf '%s\n' "${header_count}"
}

game_ready() {
  local health="$1"
  [[ "${health}" != "unhealthy" ]] || return 1
  game_query_players_raw 2>/dev/null | game_parse_player_count >/dev/null 2>&1
}

# A Zomboid world lives in two places under the data directory: the world
# itself (map chunks, plus the player and vehicle databases inside it) and the
# accounts database beside it. Archiving one without the other restores a world
# whose players do not exist, or players with no world.
game_save_paths() {
  local data_dir="$1" _world_name="$2"
  local candidate
  for candidate in Saves db; do
    [[ -d "${data_dir}/${candidate}" ]] || continue
    printf '%s\0' "${candidate}"
  done
}

game_save_sentinel() {
  local data_dir="$1" world_name="$2"
  local world_dir="${data_dir}/Saves/Multiplayer/${world_name}"
  [[ -n "$(find "${world_dir}" -maxdepth 1 -type f -name 'map_*.bin' -print -quit 2>/dev/null)" ]]
}

game_archive_sentinel_regex() {
  local world_name="$1"
  printf '^Saves/Multiplayer/%s/map_[^/]*\\.bin$' "${world_name}"
}
