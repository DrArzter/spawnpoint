#!/usr/bin/env bash

set -Eeuo pipefail

profile="${AWS_PROFILE:-spawnpoint}"
region="${AWS_REGION:-eu-central-1}"
follow=true
confirmed=false
# The machines require a world and have no default; this is the workstation's
# one remaining assumption.
world_id="${SPAWNPOINT_WORLD:-world}"
server_id="${SPAWNPOINT_SERVER_ID:-}"

game_for_world() {
  jq -r --arg id "$1" '.worlds[] | select(.id == $id) | .game // "minecraft"' \
    "$(dirname -- "${BASH_SOURCE[0]}")/../server/worlds/catalog.json"
}

usage() {
  printf 'usage: %s [--yes] [--no-follow] [--world <world-id>]\n' "$0" >&2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --yes)
      confirmed=true
      ;;
    --world)
      world_id="${2:-}"
      shift
      ;;
    --no-follow)
      follow=false
      ;;
    *)
      usage
      exit 1
      ;;
  esac
  shift
done

[[ "${world_id}" =~ ^[a-z0-9][a-z0-9-]{0,31}$ ]] || {
  printf 'error: invalid world id: %s\n' "${world_id}" >&2
  exit 1
}

for command in aws jq; do
  command -v "${command}" >/dev/null 2>&1 || {
    printf 'error: required command not found: %s\n' "${command}" >&2
    exit 1
  }
done

if [[ -z "${server_id}" ]]; then
  server_id="$(game_for_world "${world_id}")"
fi
[[ -n "${server_id}" ]] || {
  printf 'error: unknown world: %s\n' "${world_id}" >&2
  exit 1
}
[[ "${server_id}" =~ ^[a-z0-9][a-z0-9-]{0,31}$ ]] || {
  printf 'error: invalid server id: %s\n' "${server_id}" >&2
  exit 1
}

state_machine_arn="$(
  aws stepfunctions list-state-machines \
    --profile "${profile}" \
    --region "${region}" \
    --query 'stateMachines[?name==`spawnpoint-stop-server-v2`].stateMachineArn' \
    --output text
)"
[[ "${state_machine_arn}" == arn:aws:states:*:stateMachine:spawnpoint-stop-server-v2 ]] || {
  printf 'error: expected exactly one spawnpoint-stop-server-v2 state machine\n' >&2
  exit 1
}

running_execution="$(
  aws stepfunctions list-executions \
    --state-machine-arn "${state_machine_arn}" \
    --status-filter RUNNING \
    --max-results 1 \
    --profile "${profile}" \
    --region "${region}" \
    --query 'executions[0].executionArn' \
    --output text
)"
if [[ "${running_execution}" != "None" ]]; then
  printf 'result=already_running\n'
  printf 'execution_arn=%s\n' "${running_execution}"
  exit 0
fi

instance_id="$(
  aws ec2 describe-instances \
    --filters \
      Name=tag:Name,Values=spawnpoint-game-host \
      Name=instance-state-name,Values=pending,running,stopping,stopped \
    --profile "${profile}" \
    --region "${region}" \
    --query 'Reservations[].Instances[].InstanceId' \
    --output text
)"
[[ "${instance_id}" =~ ^i-[0-9a-f]+$ ]] || {
  printf 'error: expected exactly one stoppable spawnpoint-game-host instance\n' >&2
  exit 1
}

if ! ${confirmed}; then
  [[ -t 0 ]] || {
    printf 'error: stopping a session requires an interactive confirmation or --yes\n' >&2
    exit 1
  }
  printf 'Save, back up and stop Spawnpoint instance %s? [y/N] ' "${instance_id}" >&2
  read -r answer
  [[ "${answer}" == "y" || "${answer}" == "Y" ]] || {
    printf 'result=cancelled\n'
    exit 0
  }
fi

operation_id="manual-stop-$(date -u +%Y%m%dT%H%M%SZ)"
session_id="$(
  aws dynamodb get-item \
    --table-name spawnpoint-lifecycle-v2 \
    --key "{\"server_id\":{\"S\":\"${server_id}\"}}" \
    --consistent-read \
    --profile "${profile}" \
    --region "${region}" \
    --query 'Item.lifecycle.M.activeSessionId.S' \
    --output text
)"
if [[ "${session_id}" == "None" ]]; then
  session_id="closed-session"
fi
input="$(
  jq -cn \
    --arg server_id "${server_id}" \
    --arg operation_id "${operation_id}" \
    --arg session_id "${session_id}" \
    --arg instance_id "${instance_id}" \
    --arg world_id "${world_id}" \
    '{
      serverId: $server_id,
      operationId: $operation_id,
      sessionId: $session_id,
      leaseTtlSeconds: 1800,
      instanceId: $instance_id,
      worldId: $world_id,
      stopTiming: {
        ssmPollSeconds: 10,
        commandPollSeconds: 15,
        instancePollSeconds: 10,
        maxSsmPolls: 30,
        maxCommandPolls: 60,
        maxInstancePolls: 30
      }
    }'
)"

execution_arn="$(
  aws stepfunctions start-execution \
    --state-machine-arn "${state_machine_arn}" \
    --name "${operation_id}" \
    --input "${input}" \
    --profile "${profile}" \
    --region "${region}" \
    --query executionArn \
    --output text
)"

printf 'result=requested\n'
printf 'operation_id=%s\n' "${operation_id}"
printf 'execution_arn=%s\n' "${execution_arn}"

if ! ${follow}; then
  exit 0
fi

while true; do
  execution="$(
    aws stepfunctions describe-execution \
      --execution-arn "${execution_arn}" \
      --profile "${profile}" \
      --region "${region}" \
      --output json
  )"
  status="$(jq -r .status <<<"${execution}")"
  printf 'status=%s\n' "${status}"
  [[ "${status}" == "RUNNING" ]] || break
  sleep 10
done

if [[ "${status}" == "SUCCEEDED" ]]; then
  jq -r '.output | fromjson | to_entries[] | "\(.key)=\(.value)"' <<<"${execution}"
  exit 0
fi

jq -r '"error=\(.error // "unknown")\ncause=\(.cause // "not reported")"' <<<"${execution}" >&2
exit 1
