#!/usr/bin/env bash

# The game a record belongs to when it names none (ADR-0089): worlds, profiles
# and releases written before games were an axis. The game module whose
# manifest sets legacy_default owns them; no script names that game.
#
# shellcheck shell=bash

legacy_game_id() {
  local games_dir
  games_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
  jq -ers 'map(select(.legacy_default == true) | .id) | if length == 1 then .[0] else error("exactly one game manifest must set legacy_default") end' \
    "${games_dir}"/*/game.json
}

if [[ -z "${LEGACY_GAME_ID:-}" ]]; then
  LEGACY_GAME_ID="$(legacy_game_id)" || exit 1
fi
export LEGACY_GAME_ID
