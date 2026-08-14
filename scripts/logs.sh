#!/usr/bin/env bash

set -Eeuo pipefail

profile="${AWS_PROFILE:-spawnpoint}"
region="${AWS_REGION:-eu-central-1}"
lines=100

if [[ "${1:-}" == "--lines" && "${2:-}" =~ ^[0-9]+$ && $# -eq 2 ]]; then
  lines="$2"
elif [[ $# -gt 0 ]]; then
  printf 'usage: %s [--lines 1..500]\n' "$0" >&2
  exit 1
fi
((lines >= 1 && lines <= 500)) || {
  printf 'error: --lines must be between 1 and 500\n' >&2
  exit 1
}

for command in aws jq; do
  command -v "${command}" >/dev/null 2>&1 || {
    printf 'error: required command not found: %s\n' "${command}" >&2
    exit 1
  }
done

instance="$(
  aws ec2 describe-instances \
    --filters Name=tag:Name,Values=spawnpoint-game-host Name=instance-state-name,Values=pending,running,stopping,stopped \
    --profile "${profile}" --region "${region}" \
    --query 'Reservations[].Instances[].{id:InstanceId,state:State.Name}' --output json
)"
[[ "$(jq length <<<"${instance}")" == "1" ]] || {
  printf 'error: expected exactly one spawnpoint-game-host instance\n' >&2
  exit 1
}
if [[ "$(jq -r '.[0].state' <<<"${instance}")" != "running" ]]; then
  printf 'result=server_not_running\n'
  exit 0
fi
instance_id="$(jq -r '.[0].id' <<<"${instance}")"

remote_command="container_id=\$(docker ps -aq --filter label=com.docker.compose.service=mc); test -n \"\${container_id}\" || { echo result=minecraft_container_absent; exit 0; }; docker logs --tail ${lines} \"\${container_id}\" 2>&1"
parameters="$(jq -cn --arg command "${remote_command}" '{commands:["set -euo pipefail",$command]}')"
command_id="$(
  aws ssm send-command \
    --instance-ids "${instance_id}" \
    --document-name AWS-RunShellScript \
    --comment 'Spawnpoint read-only Minecraft log snapshot' \
    --parameters "${parameters}" \
    --profile "${profile}" --region "${region}" \
    --query Command.CommandId --output text
)"
aws ssm wait command-executed \
  --command-id "${command_id}" --instance-id "${instance_id}" \
  --profile "${profile}" --region "${region}" || true
invocation="$(
  aws ssm get-command-invocation \
    --command-id "${command_id}" --instance-id "${instance_id}" \
    --profile "${profile}" --region "${region}" --output json
)"
printf '%s' "$(jq -r .StandardOutputContent <<<"${invocation}")"
[[ "$(jq -r .Status <<<"${invocation}")" == "Success" ]] || {
  jq -r '.StandardErrorContent' <<<"${invocation}" >&2
  exit 1
}

