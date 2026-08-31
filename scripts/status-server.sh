#!/usr/bin/env bash

set -Eeuo pipefail

profile="${AWS_PROFILE:-spawnpoint}"
region="${AWS_REGION:-eu-central-1}"
connection_host="${SPAWNPOINT_CONNECTION_HOST:-172.29.23.24}"
# The address is composed, not configured: the host part above comes from the
# connectivity strategy, and the port from the game the world runs. Reading it
# from the same catalog the host uses keeps the two answers identical.
connect_port_for_world() {
  local world="$1" game
  game="$(jq -r --arg id "${world}" '.worlds[] | select(.id == $id) | .game // "minecraft"' \
    "$(dirname -- "${BASH_SOURCE[0]}")/../server/worlds/catalog.json")"
  [[ -n "${game}" ]] || {
    printf 'error: unknown world: %s\n' "${world}" >&2
    exit 1
  }
  awk -F'"' '/^GAME_CONNECT_PORT=/ { print $2 }' \
    "$(dirname -- "${BASH_SOURCE[0]}")/../server/games/${game}/game.sh"
}

grafana_url="${SPAWNPOINT_GRAFANA_URL:-http://172.29.23.24:3000}"

if [[ $# -gt 0 ]]; then
  printf 'usage: %s\n' "$0" >&2
  exit 1
fi

for command in aws jq date; do
  command -v "${command}" >/dev/null 2>&1 || {
    printf 'error: required command not found: %s\n' "${command}" >&2
    exit 1
  }
done

print_execution() {
  local operation="$1"
  local state_machine_arn="$2"
  local executions count status name started stopped started_ms stopped_ms duration_ms

  executions="$(
    aws stepfunctions list-executions \
      --state-machine-arn "${state_machine_arn}" \
      --max-results 1 \
      --profile "${profile}" \
      --region "${region}" \
      --output json
  )"
  count="$(jq '.executions | length' <<<"${executions}")"
  if [[ "${count}" == "0" ]]; then
    printf '%s_workflow=never_run\n' "${operation}"
    return
  fi

  status="$(jq -r '.executions[0].status' <<<"${executions}")"
  name="$(jq -r '.executions[0].name' <<<"${executions}")"
  started="$(jq -r '.executions[0].startDate' <<<"${executions}")"
  stopped="$(jq -r '.executions[0].stopDate // empty' <<<"${executions}")"
  started_ms="$(date -d "${started}" +%s%3N)"
  if [[ -n "${stopped}" ]]; then
    stopped_ms="$(date -d "${stopped}" +%s%3N)"
  else
    stopped_ms="$(date +%s%3N)"
  fi
  duration_ms="$((stopped_ms - started_ms))"

  printf '%s_workflow=%s\n' "${operation}" "${status}"
  printf '%s_execution=%s\n' "${operation}" "${name}"
  printf '%s_elapsed_seconds=%d.%03d\n' \
    "${operation}" "$((duration_ms / 1000))" "$((duration_ms % 1000))"
}

instance_json="$(
  aws ec2 describe-instances \
    --filters \
      Name=tag:Name,Values=spawnpoint-game-host \
      Name=instance-state-name,Values=pending,running,stopping,stopped \
    --profile "${profile}" \
    --region "${region}" \
    --query 'Reservations[].Instances[]' \
    --output json
)"
[[ "$(jq length <<<"${instance_json}")" == "1" ]] || {
  printf 'error: expected exactly one spawnpoint-game-host instance\n' >&2
  exit 1
}

instance_id="$(jq -r '.[0].InstanceId' <<<"${instance_json}")"
instance_state="$(jq -r '.[0].State.Name' <<<"${instance_json}")"
instance_type="$(jq -r '.[0].InstanceType' <<<"${instance_json}")"
public_ip="$(jq -r '.[0].PublicIpAddress // "none"' <<<"${instance_json}")"

printf '[server]\n'
printf 'instance_id=%s\n' "${instance_id}"
printf 'instance_state=%s\n' "${instance_state}"
printf 'instance_type=%s\n' "${instance_type}"
printf 'public_ip=%s\n' "${public_ip}"

state_machines="$(
  aws stepfunctions list-state-machines \
    --profile "${profile}" \
    --region "${region}" \
    --output json
)"
start_arn="$(jq -r '.stateMachines[] | select(.name == "spawnpoint-start-server") | .stateMachineArn' <<<"${state_machines}")"
stop_arn="$(jq -r '.stateMachines[] | select(.name == "spawnpoint-stop-server") | .stateMachineArn' <<<"${state_machines}")"
[[ "${start_arn}" == arn:aws:states:*:stateMachine:spawnpoint-start-server ]] || {
  printf 'error: spawnpoint-start-server state machine not found\n' >&2
  exit 1
}
[[ "${stop_arn}" == arn:aws:states:*:stateMachine:spawnpoint-stop-server ]] || {
  printf 'error: spawnpoint-stop-server state machine not found\n' >&2
  exit 1
}

printf '\n[operations]\n'
print_execution start "${start_arn}"
print_execution stop "${stop_arn}"

printf '\n[storage]\n'
volumes="$(
  aws ec2 describe-volumes \
    --filters Name=attachment.instance-id,Values="${instance_id}" \
    --profile "${profile}" \
    --region "${region}" \
    --output json
)"
jq -r '
  .Volumes[]
  | "volume=\(.VolumeId) size_gib=\(.Size) state=\(.State) encrypted=\(.Encrypted) delete_on_termination=\(.Attachments[0].DeleteOnTermination)"
' <<<"${volumes}"

account_id="$(
  aws sts get-caller-identity \
    --profile "${profile}" \
    --query Account \
    --output text
)"
backup_bucket="spawnpoint-backups-${account_id}"
latest_backup="$(
  aws s3api list-objects-v2 \
    --bucket "${backup_bucket}" \
    --prefix worlds/world/archives/ \
    --profile "${profile}" \
    --region "${region}" \
    --query 'sort_by(Contents,&LastModified)[-1]' \
    --output json
)"
if [[ "${latest_backup}" == "null" ]]; then
  printf 'latest_backup=none\n'
else
  backup_key="$(jq -r .Key <<<"${latest_backup}")"
  backup_head="$(
    aws s3api head-object \
      --bucket "${backup_bucket}" \
      --key "${backup_key}" \
      --profile "${profile}" \
      --region "${region}" \
      --output json
  )"
  printf 'latest_backup=%s\n' "${backup_key}"
  printf 'latest_backup_bytes=%s\n' "$(jq -r .ContentLength <<<"${backup_head}")"
  printf 'latest_backup_sha256=%s\n' "$(jq -r '.Metadata.sha256 // "missing"' <<<"${backup_head}")"
  printf 'latest_backup_version=%s\n' "$(jq -r '.VersionId // "none"' <<<"${backup_head}")"
fi

if [[ "${instance_state}" == "running" ]]; then
  printf '\n[session]\n'
  connection_address="${connection_host}:$(connect_port_for_world "${SPAWNPOINT_WORLD:-world}")"
  printf 'connection_address=%s\n' "${connection_address}"
  printf 'grafana_url=%s\n' "${grafana_url}"

  minecraft_host="${connection_address%:*}"
  minecraft_port="${connection_address##*:}"
  if command -v timeout >/dev/null 2>&1 && timeout 2 bash -c 'exec 3<>/dev/tcp/$1/$2' _ "${minecraft_host}" "${minecraft_port}" 2>/dev/null; then
    printf 'minecraft_tcp=reachable\n'
  else
    printf 'minecraft_tcp=unreachable\n'
  fi

  if command -v curl >/dev/null 2>&1 && curl --fail --silent --max-time 2 "${grafana_url}/api/health" >/dev/null; then
    printf 'grafana_http=healthy\n'
  else
    printf 'grafana_http=unreachable\n'
  fi
fi

printf '\nresult=ok\n'
