#!/usr/bin/env bash

set -Eeuo pipefail

profile="${AWS_PROFILE:-spawnpoint}"
region="${AWS_REGION:-eu-central-1}"
connection_address="${SPAWNPOINT_CONNECTION_ADDRESS:-172.29.23.24:25565}"
follow=true

if [[ "${1:-}" == "--no-follow" ]]; then
  follow=false
elif [[ $# -gt 0 ]]; then
  printf 'usage: %s [--no-follow]\n' "$0" >&2
  exit 1
fi

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
    --query 'stateMachines[?name==`spawnpoint-start-server`].stateMachineArn' \
    --output text
)"
[[ "${state_machine_arn}" == arn:aws:states:*:stateMachine:spawnpoint-start-server ]] || {
  printf 'error: expected exactly one spawnpoint-start-server state machine\n' >&2
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

operation_id="manual-$(date -u +%Y%m%dT%H%M%SZ)"
input="$(
  jq -cn \
    --arg operation_id "${operation_id}" \
    --arg instance_id "${instance_id}" \
    --arg connection_address "${connection_address}" \
    '{
      operationId: $operation_id,
      instanceId: $instance_id,
      connectionAddress: $connection_address,
      timing: {
        instancePollSeconds: 10,
        ssmPollSeconds: 10,
        commandPollSeconds: 15,
        maxInstancePolls: 30,
        maxSsmPolls: 30,
        maxCommandPolls: 60
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

# The watchdog starts with the session, unconditionally: if the session start
# later fails, the watchdog's first check sees a non-running host and ends
# cleanly. Non-fatal while the watchdog machine is not yet applied.
watchdog_arn="$(
  aws stepfunctions list-state-machines \
    --profile "${profile}" \
    --region "${region}" \
    --query 'stateMachines[?name==`spawnpoint-idle-watchdog`].stateMachineArn' \
    --output text
)"
stop_arn="$(
  aws stepfunctions list-state-machines \
    --profile "${profile}" \
    --region "${region}" \
    --query 'stateMachines[?name==`spawnpoint-stop-server`].stateMachineArn' \
    --output text
)"
if [[ "${watchdog_arn}" == arn:aws:states:*:stateMachine:spawnpoint-idle-watchdog && "${stop_arn}" == arn:aws:states:*:stateMachine:spawnpoint-stop-server ]]; then
  running_watchdog="$(
    aws stepfunctions list-executions \
      --state-machine-arn "${watchdog_arn}" \
      --status-filter RUNNING \
      --max-results 1 \
      --profile "${profile}" \
      --region "${region}" \
      --query 'executions[0].executionArn' \
      --output text
  )"
  if [[ "${running_watchdog}" != "None" ]]; then
    printf 'watchdog=already_running\n'
    printf 'watchdog_execution_arn=%s\n' "${running_watchdog}"
  else
    watchdog_input="$(
      jq -cn \
        --arg operation_id "${operation_id}" \
        --arg instance_id "${instance_id}" \
        --arg stop_arn "${stop_arn}" \
        '{
          operationId: $operation_id,
          instanceId: $instance_id,
          stopStateMachineArn: $stop_arn,
          timing: {
            checkIntervalSeconds: 300,
            emptyChecksRequired: 3,
            maxTotalChecks: 96,
            maxConsecutiveProbeFailures: 6,
            maxStopRefusals: 3,
            probePollSeconds: 10,
            maxProbePolls: 30
          },
          stopTiming: {
            instancePollSeconds: 10,
            ssmPollSeconds: 10,
            commandPollSeconds: 15,
            maxInstancePolls: 30,
            maxSsmPolls: 30,
            maxCommandPolls: 60
          }
        }'
    )"
    watchdog_execution_arn="$(
      aws stepfunctions start-execution \
        --state-machine-arn "${watchdog_arn}" \
        --name "${operation_id}" \
        --input "${watchdog_input}" \
        --profile "${profile}" \
        --region "${region}" \
        --query executionArn \
        --output text
    )"
    printf 'watchdog=requested\n'
    printf 'watchdog_execution_arn=%s\n' "${watchdog_execution_arn}"
  fi
else
  printf 'watchdog=unavailable (state machine not deployed yet)\n' >&2
fi

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
