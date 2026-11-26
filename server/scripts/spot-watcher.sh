#!/usr/bin/env bash
# Watch instance metadata for a Spot interruption (ADR-0102). Runs as the
# spawnpoint-spot-watcher service on a launched Spot host only.
#
#   spot/instance-action               the two-minute notice: save-for-interruption.sh notice, once
#   events/recommendations/rebalance   a rebalance recommendation: save once per notice time
#
# Each handled event prints one key=value block on standard output.

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly IMDS="${SPAWNPOINT_IMDS_URL:-http://169.254.169.254}"
readonly INTERVAL="${SPAWNPOINT_WATCH_INTERVAL_SECONDS:-5}"
readonly ONCE="${SPAWNPOINT_WATCH_ONCE:-false}"

# A 404 is the normal answer: nothing is scheduled. Any failure reads as none.
metadata() {
  local token
  token="$(curl --silent --fail --max-time 2 --request PUT \
    --header 'X-aws-ec2-metadata-token-ttl-seconds: 60' "${IMDS}/latest/api/token")" || return 1
  curl --silent --fail --max-time 2 --header "X-aws-ec2-metadata-token: ${token}" "${IMDS}/latest/meta-data/$1"
}

handled_notice=false
handled_rebalance=""
while :; do
  if [[ "${handled_notice}" == false ]] && action="$(metadata spot/instance-action)"; then
    handled_notice=true
    action_time="$(jq -r '.time // empty' <<<"${action}" 2>/dev/null || true)"
    printf 'event=notice\naction=%s\naction_time=%s\n' \
      "$(jq -r '.action // "unknown"' <<<"${action}" 2>/dev/null || printf unknown)" "${action_time}"
    "${SCRIPT_DIR}/save-for-interruption.sh" notice "${action_time}" || true
  elif rebalance="$(metadata events/recommendations/rebalance)"; then
    notice_time="$(jq -r '.noticeTime // empty' <<<"${rebalance}" 2>/dev/null || true)"
    if [[ -n "${notice_time}" && "${notice_time}" != "${handled_rebalance}" ]]; then
      handled_rebalance="${notice_time}"
      printf 'event=rebalance\naction=save\naction_time=%s\n' "${notice_time}"
      "${SCRIPT_DIR}/save-for-interruption.sh" rebalance || true
    fi
  fi
  [[ "${ONCE}" != true ]] || exit 0
  sleep "${INTERVAL}"
done
