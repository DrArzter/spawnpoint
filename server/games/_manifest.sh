#!/usr/bin/env bash

# A game's manifest (ADR-0088), for scripts that need one of its facts but do
# not load the module: the release scripts run in the builder's bundle, which
# carries the manifests and not the modules.
#
# shellcheck shell=bash

game_manifest_file() {
  local game_id="$1" games_dir
  [[ "${game_id}" =~ ^[a-z0-9][a-z0-9-]{0,31}$ ]] || {
    printf 'error: invalid game id: %s\n' "${game_id}" >&2
    return 1
  }
  games_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
  [[ -f "${games_dir}/${game_id}/game.json" ]] || {
    printf 'error: unknown game: %s (no manifest)\n' "${game_id}" >&2
    return 1
  }
  printf '%s\n' "${games_dir}/${game_id}/game.json"
}

# One fact as JSON; null when the manifest does not state it.
game_fact() {
  local manifest
  manifest="$(game_manifest_file "$1")" || return 1
  jq -c "$2" "${manifest}"
}
