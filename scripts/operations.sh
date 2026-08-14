#!/usr/bin/env bash

set -Eeuo pipefail

profile="${AWS_PROFILE:-spawnpoint}"
region="${AWS_REGION:-eu-central-1}"
limit=10

if [[ "${1:-}" == "--limit" && "${2:-}" =~ ^[0-9]+$ && $# -eq 2 ]]; then
  limit="$2"
elif [[ $# -gt 0 ]]; then
  printf 'usage: %s [--limit 1..50]\n' "$0" >&2
  exit 1
fi
((limit >= 1 && limit <= 50)) || {
  printf 'error: --limit must be between 1 and 50\n' >&2
  exit 1
}

for command in aws jq; do
  command -v "${command}" >/dev/null 2>&1 || {
    printf 'error: required command not found: %s\n' "${command}" >&2
    exit 1
  }
done

state_machines="$(aws stepfunctions list-state-machines --profile "${profile}" --region "${region}" --output json)"
start_arn="$(jq -r '.stateMachines[] | select(.name == "spawnpoint-start-server") | .stateMachineArn' <<<"${state_machines}")"
stop_arn="$(jq -r '.stateMachines[] | select(.name == "spawnpoint-stop-server") | .stateMachineArn' <<<"${state_machines}")"
[[ -n "${start_arn}" && -n "${stop_arn}" ]] || {
  printf 'error: Spawnpoint lifecycle state machines not found\n' >&2
  exit 1
}

start="$(aws stepfunctions list-executions --state-machine-arn "${start_arn}" --max-results "${limit}" --profile "${profile}" --region "${region}" --output json)"
stop="$(aws stepfunctions list-executions --state-machine-arn "${stop_arn}" --max-results "${limit}" --profile "${profile}" --region "${region}" --output json)"

printf 'OPERATION\tSTATUS\tSTARTED\tSTOPPED\tNAME\n'
jq -nr --argjson start "$(jq .executions <<<"${start}")" --argjson stop "$(jq .executions <<<"${stop}")" --argjson limit "${limit}" '
  ([ $start[] | . + {operation:"start"} ] + [ $stop[] | . + {operation:"stop"} ])
  | sort_by(.startDate) | reverse | .[:$limit][]
  | [.operation, .status, .startDate, (.stopDate // "-"), .name]
  | @tsv
'

