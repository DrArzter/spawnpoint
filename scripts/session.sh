#!/usr/bin/env bash

set -Eeuo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

run_action() {
  local action="$1"
  shift
  case "${action}" in
    start) "${script_dir}/start-server.sh" "$@" ;;
    status) "${script_dir}/status-server.sh" "$@" ;;
    logs) "${script_dir}/logs.sh" "$@" ;;
    players) "${script_dir}/players.sh" "$@" ;;
    backups) "${script_dir}/backups.sh" "$@" ;;
    operations) "${script_dir}/operations.sh" "$@" ;;
    stop) "${script_dir}/stop-server.sh" "$@" ;;
    *)
      printf 'usage: %s {start|status|logs|players|backups|operations|stop} [arguments]\n' "$0" >&2
      return 1
      ;;
  esac
}

if [[ $# -gt 0 ]]; then
  run_action "$@"
  exit
fi

[[ -t 0 ]] || {
  printf 'usage: %s {start|status|logs|players|backups|operations|stop} [arguments]\n' "$0" >&2
  exit 1
}

PS3='Spawnpoint action: '
select action in status start players logs backups operations stop quit; do
  [[ "${action}" == "quit" ]] && exit 0
  if [[ -n "${action}" ]]; then
    run_action "${action}" || true
    printf '\n'
  else
    printf 'error: choose a number from the menu\n' >&2
  fi
done

