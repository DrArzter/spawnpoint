#!/usr/bin/env bash

# The tick-time hook of each game module (ADR-0054 acceptance): Forge's own
# report, Factorio's tick counter sampled twice, and Zomboid's honest refusal.
# RCON is stubbed the way game-adapter-test.sh stubs it.

set -Eeuo pipefail

repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
games="${repository_root}/server/games"

expect_status() {
  local expected="$1"
  shift
  local status=0
  "$@" >/dev/null 2>&1 || status=$?
  [[ "${status}" == "${expected}" ]] || {
    printf 'expected exit %s, got %s: %s\n' "${expected}" "${status}" "$*" >&2
    exit 1
  }
}

# --- minecraft: the Overall line, whichever lines Forge prints around it ---
(
  source "${games}/minecraft/game.sh"
  rcon() {
    [[ "$*" == "forge tps" ]] || exit 99
    printf 'Dim minecraft:overworld (Overworld): Mean tick time: 3.981 ms. Mean TPS: 20.000\n'
    printf 'Overall: Mean tick time: 4.123 ms. Mean TPS: 20.000\n'
  }
  [[ "$(game_tick_time_ms)" == "4.123" ]]
  rcon() { printf 'Unknown command\n'; }
  expect_status 1 game_tick_time_ms
  rcon() { return 1; }
  expect_status 1 game_tick_time_ms
)

# --- factorio: two readings a second apart, sixty ticks between them ---
readings="$(mktemp /tmp/spawnpoint-tick-time-test.XXXXXXXX)"
trap 'rm -f -- "${readings}"' EXIT
(
  export SPAWNPOINT_ACCEPT_ACHIEVEMENT_LOSS=1
  export FACTORIO_TICK_SAMPLE_SECONDS=1
  source "${games}/factorio/game.sh"
  # The hook reads each answer in a subshell, so the stub counts in a file.
  factorio_rcon() {
    [[ "$1" == "/silent-command rcon.print(game.tick)" ]] || exit 99
    printf 'x' >>"${readings}"
    case "$(wc -c <"${readings}" | tr -d ' ')" in
      1) printf '120000\n' ;;
      *) printf '120060\n' ;;
    esac
  }
  [[ "$(game_tick_time_ms)" == "16.667" ]]
  # A paused game does not advance; that is an error, not zero milliseconds.
  factorio_rcon() { printf '5\n'; }
  expect_status 1 game_tick_time_ms
)
# Without consent to the achievement loss the module refuses, with exit 2 like
# a game that cannot measure at all.
(
  export FACTORIO_TICK_SAMPLE_SECONDS=1
  source "${games}/factorio/game.sh"
  factorio_rcon() { exit 99; }
  expect_status 2 game_tick_time_ms
)

# --- zomboid: nothing to read ---
(
  source "${games}/zomboid/game.sh"
  expect_status 2 game_tick_time_ms
)

printf 'result=passed\n'
