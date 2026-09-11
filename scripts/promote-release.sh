#!/usr/bin/env bash

set -Eeuo pipefail

profile="${AWS_PROFILE:-spawnpoint}"
region="${AWS_REGION:-eu-central-1}"
connection_host="${SPAWNPOINT_CONNECTION_HOST:-172.29.23.24}"
repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"

usage() {
  printf 'usage: %s <world> <release> [--no-follow]\n' "$0" >&2
}

connect_port_for_game() {
  awk -F'"' '/^GAME_CONNECT_PORT=/ { print $2 }' "${repository_root}/server/games/$1/game.sh"
}

follow=true
world="${1:-}"
release="${2:-}"
if [[ "${3:-}" == "--no-follow" ]]; then
  follow=false
elif [[ $# -gt 2 ]]; then
  usage
  exit 1
fi

[[ -n "${world}" && -n "${release}" ]] || {
  usage
  exit 1
}
[[ "${world}" =~ ^[a-z0-9][a-z0-9-]{0,31}$ ]] || {
  printf 'error: unsafe world name: %s\n' "${world}" >&2
  exit 1
}
[[ "${release}" =~ ^[0-9]+\.[0-9]+$ ]] || {
  printf 'error: release must use MAJOR.MINOR: %s\n' "${release}" >&2
  exit 1
}

for command in aws jq; do
  command -v "${command}" >/dev/null 2>&1 || {
    printf 'error: required command not found: %s\n' "${command}" >&2
    exit 1
  }
done

promote_arn="$(
  aws stepfunctions list-state-machines --profile "${profile}" --region "${region}" --query 'stateMachines[?name==`spawnpoint-promote-release`].stateMachineArn' --output text
)"
[[ "${promote_arn}" == arn:aws:states:*:stateMachine:spawnpoint-promote-release ]] || {
  printf 'error: expected exactly one spawnpoint-promote-release state machine\n' >&2
  exit 1
}

running_promotion="$(
  aws stepfunctions list-executions --state-machine-arn "${promote_arn}" --status-filter RUNNING --max-results 1 --profile "${profile}" --region "${region}" --query 'executions[0].executionArn' --output text
)"
if [[ "${running_promotion}" != "None" ]]; then
  printf 'result=already_running\n'
  printf 'execution_arn=%s\n' "${running_promotion}"
  exit 0
fi

instance_id="$(
  aws ec2 describe-instances --filters Name=tag:Name,Values=spawnpoint-game-host Name=instance-state-name,Values=pending,running,stopping,stopped --profile "${profile}" --region "${region}" --query 'Reservations[].Instances[].InstanceId' --output text
)"
[[ "${instance_id}" =~ ^i-[0-9a-f]+$ ]] || {
  printf 'error: expected exactly one spawnpoint-game-host instance\n' >&2
  exit 1
}

account_id="$(aws sts get-caller-identity --profile "${profile}" --query Account --output text)"
release_bucket="${RELEASE_BUCKET:-spawnpoint-releases-${account_id}}"
world_record="$({
  aws s3 cp "s3://${release_bucket}/worlds/${world}/world.json" - --profile "${profile}" --region "${region}"
} 2>/dev/null)" || {
  printf 'error: world is not registered: %s\n' "${world}" >&2
  exit 1
}

world_identity="$(jq -cer --arg world "${world}" '
  select(.schema_version == 1 and .world_id == $world and .storage_layout == "generation") |
  {
    generationId: (.current_generation.id | select(test("^gen-[0-9a-f]{32}$"))),
    gameId: (.game | select(test("^[a-z0-9][a-z0-9-]{0,31}$"))),
    presetId: (.preset.id | select(test("^[a-z0-9][a-z0-9-]{0,31}$")))
  }
' <<<"${world_record}")" || {
  printf 'error: world registry has no valid current wipe, game or preset: %s\n' "${world}" >&2
  exit 1
}
generation_id="$(jq -r .generationId <<<"${world_identity}")"
game_id="$(jq -r .gameId <<<"${world_identity}")"
preset_id="$(jq -r .presetId <<<"${world_identity}")"
connect_port="$(connect_port_for_game "${game_id}")"
[[ "${connect_port}" =~ ^[0-9]+$ ]] || {
  printf 'error: unsupported game adapter: %s\n' "${game_id}" >&2
  exit 1
}

operation_id="promote-$(date -u +%Y%m%dT%H%M%SZ)"
input="$(
  jq -cn --arg operation_id "${operation_id}" --arg world "${world}" --arg generation_id "${generation_id}" --arg game_id "${game_id}" --arg preset_id "${preset_id}" --arg release "${release}" --arg instance_id "${instance_id}" --arg release_bucket "${release_bucket}" --arg connection_address "${connection_host}:${connect_port}" '{
      operationId: $operation_id,
      serverId: $game_id,
      worldId: $world,
      generationId: $generation_id,
      gameId: $game_id,
      presetId: $preset_id,
      release: $release,
      instanceId: $instance_id,
      releaseBucket: $release_bucket,
      connectionAddress: $connection_address,
      leaseTtlSeconds: 1800,
      watchdogRegistrationLeaseTtlSeconds: 60,
      watchdogStopLeaseTtlSeconds: 1800,
      startTiming: {
        instancePollSeconds: 10, ssmPollSeconds: 10, commandPollSeconds: 15,
        maxInstancePolls: 30, maxSsmPolls: 30, maxCommandPolls: 60
      },
      stopTiming: {
        instancePollSeconds: 10, ssmPollSeconds: 10, commandPollSeconds: 15,
        maxInstancePolls: 30, maxSsmPolls: 30, maxCommandPolls: 60
      },
      watchdogTiming: {
        checkIntervalSeconds: 300, emptyChecksRequired: 3, maxTotalChecks: 96,
        maxConsecutiveProbeFailures: 6, maxStopRefusals: 3,
        probePollSeconds: 10, maxProbePolls: 30
      }
    }'
)"

execution_arn="$(
  aws stepfunctions start-execution --state-machine-arn "${promote_arn}" --name "${operation_id}" --input "${input}" --profile "${profile}" --region "${region}" --query executionArn --output text
)"

printf 'result=requested\n'
printf 'operation_id=%s\n' "${operation_id}"
printf 'execution_arn=%s\n' "${execution_arn}"

if ! ${follow}; then
  exit 0
fi

while true; do
  execution="$(
    aws stepfunctions describe-execution --execution-arn "${execution_arn}" --profile "${profile}" --region "${region}" --output json
  )"
  status="$(jq -r .status <<<"${execution}")"
  printf 'status=%s\n' "${status}"
  [[ "${status}" == "RUNNING" ]] || break
  sleep 15
done

if [[ "${status}" == "SUCCEEDED" ]]; then
  jq -r '.output | fromjson | to_entries[] | "\(.key)=\(.value)"' <<<"${execution}"
  exit 0
fi

jq -r '"error=\(.error // "unknown")\ncause=\(.cause // "not reported")"' <<<"${execution}" >&2
exit 1
