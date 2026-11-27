#!/usr/bin/env bash
# One session's save for a Spot interruption (ADR-0103): the save phase in the
# way the game declares, then the check that the save reached the disk. The
# announce, flush and report phases are the watcher's, the same for every game.
#
#   save-session-for-interruption.sh <notice|rebalance> <since-epoch-seconds>
#
# `interruption.save` in game.json says how the game saves:
#   live  game_save writes the world while the game runs; a deferred answer is
#         not a save
#   stop  only a graceful stop writes the world: the game is stopped, so its
#         players leave at the notice; a rebalance recommendation does not stop it
#
# Every branch prints the same keys: result (saved, failed, skipped), method,
# reason and seconds. It exits non-zero only for failed.

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"

kind="${1:-}"
since="${2:-}"
[[ ("${kind}" == "notice" || "${kind}" == "rebalance") && "${since}" =~ ^[0-9]+$ ]] || {
  printf 'usage: %s <notice|rebalance> <since-epoch-seconds>\n' "$0" >&2
  exit 2
}

method="none"
started="${SECONDS}"
report() {
  printf 'result=%s\nmethod=%s\nreason=%s\nseconds=%s\n' "$1" "${method}" "${2:-}" "$((SECONDS - started))"
  [[ "$1" != "failed" ]]
}

# shellcheck source=../games/_dispatch.sh
source "${SERVER_DIR}/games/_dispatch.sh"
resolve_game
prepare_game_runtime
configure_game_compose
# shellcheck source=_common.sh
source "${SCRIPT_DIR}/_common.sh"
# shellcheck source=../games/_manifest.sh
source "${SERVER_DIR}/games/_manifest.sh"

method="$(game_fact "${GAME_ID}" '.interruption.save // "none"' | jq -r .)"
budget="$(game_fact "${GAME_ID}" '.interruption.save_budget_seconds // 0' | jq -r .)"
if [[ "${method}" != "live" && "${method}" != "stop" ]]; then
  report failed no_interruption_contract || exit 1
fi
if [[ "${kind}" == "rebalance" && "${method}" == "stop" ]]; then
  # A recommendation is not a reclaim; it does not cost the players their game.
  report skipped stops_the_game
  exit 0
fi

# A session volume holds a generation world (ADR-0102), whose data and name are its own.
[[ "${WORLD_STORAGE_LAYOUT:-legacy}" == "generation" ]] || { report failed not_a_generation_world || exit 1; }
data_dir="${WORLD_DATA_DIRECTORY}"
world_name="${WORLD_ID}"

[[ "$(container_state)" == "running" ]] || { report failed game_not_running || exit 1; }

case "${method}" in
  live)
    save_output="$(game_save)" || { report failed save_failed || exit 1; }
    if grep -q '^save_deferred=' <<<"${save_output}"; then
      report failed save_deferred || exit 1
    fi
    ;;
  stop)
    # The same graceful stop as stop.sh: the image saves on SIGTERM and exits.
    compose stop >/dev/null || { report failed stop_failed || exit 1; }
    [[ "$(container_state)" == "exited" ]] || { report failed stop_failed || exit 1; }
    ;;
esac

# The check: a save file written since the notice, and no write for two
# seconds, so a save that runs on after its command returned is waited for.
newest_save_write() {
  local paths=() path newest=0 stamp
  game_save_sentinel "${data_dir}" "${world_name}" 2>/dev/null || { printf '0\n'; return; }
  mapfile -d '' paths < <(game_save_paths "${data_dir}" "${world_name}")
  for path in "${paths[@]}"; do
    stamp="$(find "${data_dir}/${path}" -type f -printf '%T@\n' 2>/dev/null | awk 'BEGIN { m = 0 } { if ($1 > m) m = $1 } END { printf "%d", m }')"
    (( stamp <= newest )) || newest="${stamp}"
  done
  printf '%s\n' "${newest}"
}

deadline=$((started + budget))
while :; do
  written="$(newest_save_write)"
  if (( written >= since && $(date +%s) - written >= 2 )); then
    report saved
    exit 0
  fi
  (( SECONDS < deadline )) || { report failed save_not_on_disk || exit 1; }
  sleep 1
done
