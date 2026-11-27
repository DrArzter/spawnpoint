#!/usr/bin/env bash
# Save every session on this host for a Spot interruption (ADR-0102), in the
# phases every game shares (ADR-0103):
#
#   1 announce  the countdown, where the game can
#   2 save      in the way the game declares (save-session-for-interruption.sh)
#   3 check     that the save reached the disk (the same script)
#   4 flush     the session volume
#   5 report    saved, failed and skipped, to the control plane
#
#   notice     all five; a game that saves only on a graceful stop is stopped
#   rebalance  save and check only, and only for a game that saves while it runs
#
# Nothing goes to S3 here: the session volume outlives the instance. The report
# is one EventBridge event (source spawnpoint.host) on the default bus; the
# host has no other channel that does not wait for the control plane to ask.

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
# shellcheck source=_session-records.sh
source "${SCRIPT_DIR}/_session-records.sh"

runtime_env="${SERVER_ENV_FILE:-${SERVER_DIR}/.env}"
# The words players read, for every game. {when} becomes the countdown.
readonly NOTICE_TEXT='This server moves to a new machine {when}. Your world is being saved.'
readonly SAVED_TEXT='World saved. Reconnect to the same address in a few minutes.'

kind="${1:-}"
action_time="${2:-}"
[[ "${kind}" == "notice" || "${kind}" == "rebalance" ]] || {
  printf 'usage: %s <notice|rebalance> [action-time]\n' "$0" >&2
  exit 2
}

read_env_value() {
  [[ -f "${runtime_env}" ]] || return 1
  awk -F= -v key="$1" '$1 == key { print substr($0, index($0, "=") + 1); found = 1; exit } END { if (!found) exit 1 }' \
    "${runtime_env}"
}

countdown() {
  local remaining
  remaining=120
  if [[ -n "${action_time}" ]]; then
    remaining=$(($(date -u -d "${action_time}" +%s) - $(date -u +%s))) || remaining=120
  fi
  if (( remaining >= 90 )); then
    printf 'in about %s minutes' "$(((remaining + 30) / 60))"
  elif (( remaining > 0 )); then
    printf 'in %s seconds' "${remaining}"
  else
    printf 'now'
  fi
}

# Runs one host script for one session, with the session's own environment.
for_session() {
  local record="$1" script="$2"
  shift 2
  WORLD_ID="$(session_record_value "${record}" world_id)" \
    SPAWNPOINT_SLOT="$(session_record_value "${record}" slot)" \
    SPAWNPOINT_SESSION_VOLUME_ID="$(session_record_value "${record}" session_volume_id)" \
    SPAWNPOINT_WORLD_CATALOG="$(session_record_value "${record}" world_catalog)" \
    "${SCRIPT_DIR}/${script}" "$@"
}

saved=()
failed=()
skipped=()
records=()
if [[ -d "${SESSION_RECORDS_DIRECTORY}" ]]; then
  shopt -s nullglob
  records=("${SESSION_RECORDS_DIRECTORY}"/*.record)
  shopt -u nullglob
fi

# A save counts only when it was written after this moment.
since="$(($(date +%s) - 1))"
notice_text="${NOTICE_TEXT//\{when\}/$(countdown)}"
for record in "${records[@]}"; do
  world_id="$(session_record_value "${record}" world_id)"
  [[ "${world_id}" =~ ^[a-z0-9][a-z0-9-]{0,31}$ ]] || {
    printf 'warning: skipping a record with no valid world: %s\n' "${record}" >&2
    continue
  }
  if [[ "${kind}" == "notice" ]]; then
    for_session "${record}" announce-world.sh "${notice_text}" >&2 || true
  fi
  save_output="$(for_session "${record}" save-session-for-interruption.sh "${kind}" "${since}")" || true
  printf '%s\n' "${save_output}" | sed "s/^/${world_id}: /" >&2
  result="$(awk -F= '$1 == "result" { print $2 }' <<<"${save_output}")"
  method="$(awk -F= '$1 == "method" { print $2 }' <<<"${save_output}")"
  case "${result}" in
    saved)
      if [[ "${kind}" == "notice" ]]; then
        sync -f -- "$(realpath -m -- "${SPAWNPOINT_WORLDS_DIRECTORY:-${SERVER_DIR}/runtime/worlds}")/${world_id}" || true
        # A game stopped to save has nobody left to tell.
        [[ "${method}" != "live" ]] || for_session "${record}" announce-world.sh "${SAVED_TEXT}" >&2 || true
      fi
      saved+=("${world_id}")
      ;;
    skipped) skipped+=("${world_id}") ;;
    *) failed+=("${world_id}") ;;
  esac
done

join() {
  local IFS=,
  printf '%s' "$*"
}

reported=false
if [[ "${kind}" == "notice" ]]; then
  instance_id="${SPAWNPOINT_INSTANCE_ID:-$(read_env_value SPAWNPOINT_INSTANCE_ID || true)}"
  region="${AWS_REGION:-$(read_env_value AWS_REGION || true)}"
  detail="$(jq -cn --arg instance "${instance_id}" --arg action_time "${action_time}" \
    --arg saved "$(join "${saved[@]}")" --arg failed "$(join "${failed[@]}")" --arg skipped "$(join "${skipped[@]}")" '
    def list: if . == "" then [] else split(",") end;
    {instanceId: $instance, actionTime: (if $action_time == "" then null else $action_time end),
     saved: ($saved | list), failed: ($failed | list), skipped: ($skipped | list)}')"
  entries="$(jq -cn --arg detail "${detail}" \
    '[{Source: "spawnpoint.host", DetailType: "Sessions saved for interruption", Detail: $detail}]')"
  if [[ -n "${instance_id}" && -n "${region}" ]] &&
    aws events put-events --region "${region}" --entries "${entries}" --output json >&2; then
    reported=true
  fi
fi

printf 'kind=%s\n' "${kind}"
printf 'sessions=%s\n' "${#records[@]}"
printf 'saved=%s\n' "$(join "${saved[@]}")"
printf 'failed=%s\n' "$(join "${failed[@]}")"
printf 'skipped=%s\n' "$(join "${skipped[@]}")"
printf 'reported=%s\n' "${reported}"
(( ${#failed[@]} == 0 ))
