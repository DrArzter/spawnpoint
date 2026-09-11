#!/usr/bin/env bash

set -Eeuo pipefail

profile="${AWS_PROFILE:-spawnpoint}"
region="${AWS_REGION:-eu-central-1}"
connection_host="${SPAWNPOINT_CONNECTION_HOST:-172.29.23.24}"
# The address is composed, not configured: the host part above comes from the
# connectivity strategy, and the port from the game the world runs. Reading it
# from the same catalog the host uses keeps the two answers identical.
game_for_world() {
  local world="$1" game
  game="$(jq -r --arg id "${world}" '.worlds[] | select(.id == $id) | .game // "minecraft"' \
    "$(dirname -- "${BASH_SOURCE[0]}")/../server/worlds/catalog.json")"
  [[ -n "${game}" ]] || {
    printf 'error: unknown world: %s\n' "${world}" >&2
    exit 1
  }
  printf '%s\n' "${game}"
}

connect_port_for_game() {
  awk -F'"' '/^GAME_CONNECT_PORT=/ { print $2 }' \
    "$(dirname -- "${BASH_SOURCE[0]}")/../server/games/$1/game.sh"
}

follow=true
# Which world this session runs. The machines require it and have no default,
# so this is the one place a workstation start still assumes something.
world_id="${SPAWNPOINT_WORLD:-world}"

while (( $# > 0 )); do
  case "$1" in
    --no-follow)
      follow=false
      shift
      ;;
    --world)
      world_id="${2:-}"
      shift 2
      ;;
    *)
      printf 'usage: %s [--no-follow] [--world <world-id>]\n' "$0" >&2
      exit 1
      ;;
  esac
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

state_machine_arn="$(
  aws stepfunctions list-state-machines \
    --profile "${profile}" \
    --region "${region}" \
    --query 'stateMachines[?name==`spawnpoint-start-server-v2`].stateMachineArn' \
    --output text
)"
[[ "${state_machine_arn}" == arn:aws:states:*:stateMachine:spawnpoint-start-server-v2 ]] || {
  printf 'error: expected exactly one spawnpoint-start-server-v2 state machine\n' >&2
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
  printf 'error: expected exactly one startable spawnpoint-game-host instance\n' >&2
  exit 1
}

server_id="$(game_for_world "${world_id}")"
[[ "${server_id}" =~ ^[a-z0-9][a-z0-9-]{0,31}$ ]] || {
  printf 'error: invalid server id: %s\n' "${server_id}" >&2
  exit 1
}
connection_address="${connection_host}:$(connect_port_for_game "${server_id}")"
operation_id="manual-$(date -u +%Y%m%dT%H%M%SZ)"
session_id="session-${operation_id}"
input="$(
  jq -cn \
    --arg operation_id "${operation_id}" \
    --arg server_id "${server_id}" \
    --arg session_id "${session_id}" \
    --arg instance_id "${instance_id}" \
    --arg world_id "${world_id}" \
    --arg connection_address "${connection_address}" \
    '{
      serverId: $server_id,
      operationId: $operation_id,
      sessionId: $session_id,
      leaseTtlSeconds: 1800,
      watchdogRegistrationLeaseTtlSeconds: 60,
      watchdogStopLeaseTtlSeconds: 1800,
      instanceId: $instance_id,
      worldId: $world_id,
      connectionAddress: $connection_address,
      startTiming: {
        instancePollSeconds: 10,
        ssmPollSeconds: 10,
        commandPollSeconds: 15,
        maxInstancePolls: 30,
        maxSsmPolls: 30,
        maxCommandPolls: 60
      },
      stopTiming: {
        instancePollSeconds: 10,
        ssmPollSeconds: 10,
        commandPollSeconds: 15,
        maxInstancePolls: 30,
        maxSsmPolls: 30,
        maxCommandPolls: 60
      },
      watchdogTiming: {
        checkIntervalSeconds: 300,
        emptyChecksRequired: 3,
        maxTotalChecks: 96,
        maxConsecutiveProbeFailures: 6,
        maxStopRefusals: 3,
        probePollSeconds: 10,
        maxProbePolls: 30
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
