#!/usr/bin/env bash

# The acceptance run of ADR-0054 (docs/capacity-allocation-rollout.md, phase 10),
# as commands rather than a checklist: each one drives the deployed machines the
# way the API does, reads what happened from the execution history and the host
# record, and appends one JSON line to a record file. `report` turns the record
# into the document the rollout asks for. Nothing here changes the deployment;
# `placement = "shared"` (and `launch`) are Terraform settings on the access-api
# root, and this asks for `shared` per start so the setting can stay `single`
# while the run happens.
#
#   acceptance-capacity-allocation.sh start  --world <id> [--game <id>] [--launch disabled|enabled] [--app-commit <ref>]
#   acceptance-capacity-allocation.sh tick   --world <id>
#   acceptance-capacity-allocation.sh stop   --world <id>
#   acceptance-capacity-allocation.sh drain  --host <instance-id> [--timeout-seconds <n>]
#   acceptance-capacity-allocation.sh join   --world <id> --kind srv|host-port --player <name> [--note <text>]
#   acceptance-capacity-allocation.sh report [--out <file>]
#
# Every command takes --record <dir> (default acceptance/capacity-allocation);
# AWS_PROFILE (spawnpoint) and AWS_REGION (eu-central-1) as the other scripts.
# --game names the world's game when the world is not in server/worlds/catalog.json
# — a world created from a preset, which is what the second tenant will be.

set -Eeuo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
profile="${AWS_PROFILE:-spawnpoint}"
region="${AWS_REGION:-eu-central-1}"
poll_seconds="${SPAWNPOINT_POLL_SECONDS:-10}"
record_dir="acceptance/capacity-allocation"
coordinator_function="spawnpoint-lifecycle-coordinator-v2"

usage() {
  sed -n '/^#   acceptance-capacity-allocation.sh/,/^#$/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,3\}//' >&2
  exit 1
}

for command in aws jq; do
  command -v "${command}" >/dev/null 2>&1 || {
    printf 'error: required command not found: %s\n' "${command}" >&2
    exit 1
  }
done

aws_json() {
  aws "$@" --profile "${profile}" --region "${region}" --output json
}

# Step Functions dates carry microseconds and an offset; jq wants neither.
readonly JQ_TIME='def ts: sub("\\+00:00$"; "Z") | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601;'

events_file() {
  printf '%s/events.jsonl\n' "${record_dir}"
}

record_event() {
  local event="$1"
  mkdir -p -- "${record_dir}"
  jq -c . <<<"${event}" >>"$(events_file)"
  jq -r 'to_entries[] | "\(.key)=\(.value | tostring)"' <<<"${event}"
}

game_for_world() {
  local world_id="$1"
  jq -r --arg id "${world_id}" '.worlds[] | select(.id == $id) | .game // "minecraft"' "${script_dir}/../server/worlds/catalog.json"
}

state_machine_arn() {
  local name="$1" arn
  arn="$(aws_json stepfunctions list-state-machines | jq -r --arg name "${name}" '.stateMachines[] | select(.name == $name) | .stateMachineArn')"
  [[ "${arn}" == arn:aws:states:*:stateMachine:"${name}" ]] || {
    printf 'error: expected exactly one %s state machine\n' "${name}" >&2
    exit 1
  }
  printf '%s\n' "${arn}"
}

configured_instance_id() {
  local id
  id="$(aws_json ec2 describe-instances \
    --filters Name=tag:Name,Values=spawnpoint-game-host Name=instance-state-name,Values=pending,running,stopping,stopped \
    | jq -r '[.Reservations[].Instances[].InstanceId] | if length == 1 then .[0] else empty end')"
  [[ "${id}" =~ ^i-[0-9a-f]+$ ]] || {
    printf 'error: expected exactly one spawnpoint-game-host instance\n' >&2
    exit 1
  }
  printf '%s\n' "${id}"
}

instance_state() {
  local instance_id="$1"
  aws_json ec2 describe-instances --instance-ids "${instance_id}" \
    | jq -r '.Reservations[].Instances[].State.Name // "unknown"' | head -n1
}

follow_execution() {
  local arn="$1" execution status
  while true; do
    execution="$(aws_json stepfunctions describe-execution --execution-arn "${arn}")"
    status="$(jq -r .status <<<"${execution}")"
    printf 'status=%s\n' "${status}" >&2
    [[ "${status}" == "RUNNING" ]] || break
    sleep "${poll_seconds}"
  done
  printf '%s\n' "${execution}"
}

execution_history() {
  local execution_arn="$1"
  aws_json stepfunctions get-execution-history --execution-arn "${execution_arn}" --max-results 1000 --include-execution-data
}

# The host record, as the coordinator holds it: the same read the machines do.
host_record() {
  local host_id="$1" outfile payload
  outfile="$(mktemp)"
  payload="$(jq -cn --arg hostId "${host_id}" '{action: "getHost", hostId: $hostId}')"
  aws_json lambda invoke --function-name "${coordinator_function}" \
    --cli-binary-format raw-in-base64-out --payload "${payload}" "${outfile}" >/dev/null
  jq -c '.host.record // .host // empty' "${outfile}"
  rm -f -- "${outfile}"
}

timing_json() {
  jq -cn '{
    startTiming: {instancePollSeconds: 10, ssmPollSeconds: 10, commandPollSeconds: 15, maxInstancePolls: 30, maxSsmPolls: 30, maxCommandPolls: 60},
    stopTiming: {instancePollSeconds: 10, ssmPollSeconds: 10, commandPollSeconds: 15, maxInstancePolls: 30, maxSsmPolls: 30, maxCommandPolls: 60},
    watchdogTiming: {checkIntervalSeconds: 300, emptyChecksRequired: 3, maxTotalChecks: 96, maxConsecutiveProbeFailures: 6, maxStopRefusals: 3, probePollSeconds: 10, maxProbePolls: 30}
  }'
}

# --- start: request a shared placement and read where it landed and when it was ready ---
cmd_start() {
  local world_id="" game_id="" launch="disabled" app_commit="main"
  while (( $# > 0 )); do
    case "$1" in
      --world) world_id="${2:-}"; shift 2 ;;
      --game) game_id="${2:-}"; shift 2 ;;
      --launch) launch="${2:-}"; shift 2 ;;
      --app-commit) app_commit="${2:-}"; shift 2 ;;
      --record) record_dir="${2:-}"; shift 2 ;;
      *) usage ;;
    esac
  done
  [[ "${world_id}" =~ ^[a-z0-9][a-z0-9-]{0,31}$ ]] || usage
  [[ "${launch}" == "disabled" || "${launch}" == "enabled" ]] || usage

  local server_id operation_id session_id instance_id input arn execution_arn execution history
  server_id="${game_id:-$(game_for_world "${world_id}")}"
  [[ "${server_id}" =~ ^[a-z0-9][a-z0-9-]{0,31}$ ]] || {
    printf 'error: world %s is not in server/worlds/catalog.json; name its game with --game\n' "${world_id}" >&2
    exit 1
  }
  operation_id="accept-$(date -u +%Y%m%dT%H%M%SZ)-$(od -An -N2 -tx1 /dev/urandom | tr -d ' \n')"
  session_id="session-${operation_id}"
  instance_id="$(configured_instance_id)"
  input="$(jq -cn \
    --arg serverId "${server_id}" --arg operationId "${operation_id}" --arg sessionId "${session_id}" \
    --arg instanceId "${instance_id}" --arg worldId "${world_id}" --arg launch "${launch}" --arg appCommit "${app_commit}" \
    --argjson timing "$(timing_json)" \
    '{serverId: $serverId, operationId: $operationId, sessionId: $sessionId,
      leaseTtlSeconds: 1800, watchdogRegistrationLeaseTtlSeconds: 60, watchdogStopLeaseTtlSeconds: 1800,
      instanceId: $instanceId, worldId: $worldId, placement: "shared", launch: $launch, appCommit: $appCommit} + $timing')"
  arn="$(state_machine_arn spawnpoint-start-server-v2)"
  execution_arn="$(aws_json stepfunctions start-execution --state-machine-arn "${arn}" --name "${operation_id}" --input "${input}" | jq -r .executionArn)"
  printf 'execution_arn=%s\n' "${execution_arn}" >&2
  execution="$(follow_execution "${execution_arn}")"
  history="$(execution_history "${execution_arn}")"

  local summary host_id neighbours
  summary="$(jq -cn --argjson execution "${execution}" --argjson history "${history}" "${JQ_TIME}"'
    ($history.events) as $events
    | ($events | map(select(.type == "TaskStateExited" and .stateExitedEventDetails.name == "Mark Session Ready")) | first) as $ready
    | ($events | map(select(.type == "PassStateExited" and (.stateExitedEventDetails.name == "Adopt Placement" or .stateExitedEventDetails.name == "Adopt Configured Host"))) | first) as $adopted
    | ($events | map(select(.type == "TaskStateExited" and .stateExitedEventDetails.name == "Launch Host")) | first) as $launched
    | ($events | map(select(.type == "TaskStateExited" and .stateExitedEventDetails.name == "Describe Launched Host Shape")) | first) as $shape
    | ($execution.output // "{}" | fromjson) as $output
    | {
        status: $execution.status,
        requestedAt: $execution.startDate,
        readyAt: ($ready.timestamp // null),
        secondsToReady: (if $ready then (($ready.timestamp | ts) - ($execution.startDate | ts)) else null end),
        placed: (if $adopted then ($adopted.stateExitedEventDetails.output | fromjson | .request.placed) else null end),
        placement: (if $launched then "launch" else "reuse" end),
        launched: (if $launched then {
            instanceId: ($launched.stateExitedEventDetails.output | fromjson | .Instances[0].InstanceIds[0] // null),
            instanceType: (if $shape then ($shape.stateExitedEventDetails.output | fromjson | .InstanceTypes[0].InstanceType // null) else null end)
          } else null end),
        connectionAddress: ($output.connectionAddress // null),
        error: ($execution.error // null)
      }')"
  host_id="$(jq -r '.placed.hostId // empty' <<<"${summary}")"
  neighbours="null"
  if [[ -n "${host_id}" ]]; then
    neighbours="$(host_record "${host_id}" | jq '(.reservations | length) - 1' 2>/dev/null || printf 'null')"
  fi
  record_event "$(jq -cn \
    --arg world "${world_id}" --arg serverId "${server_id}" --arg sessionId "${session_id}" \
    --arg operationId "${operation_id}" --arg executionArn "${execution_arn}" --arg launch "${launch}" \
    --argjson summary "${summary}" --argjson neighbours "${neighbours}" \
    '{event: "start", world: $world, serverId: $serverId, sessionId: $sessionId, operationId: $operationId,
      executionArn: $executionArn, launchSetting: $launch, neighboursAtStart: $neighbours} + $summary')"
  [[ "$(jq -r .status <<<"${summary}")" == "SUCCEEDED" ]]
}

# --- tick: one reading from the session's own project on its host ---
cmd_tick() {
  local world_id=""
  while (( $# > 0 )); do
    case "$1" in
      --world) world_id="${2:-}"; shift 2 ;;
      --record) record_dir="${2:-}"; shift 2 ;;
      *) usage ;;
    esac
  done
  [[ -n "${world_id}" ]] || usage
  local started host_id slot command_id invocation status output
  started="$(jq -cs --arg world "${world_id}" 'map(select(.event == "start" and .world == $world)) | last // empty' "$(events_file)")"
  [[ -n "${started}" ]] || {
    printf 'error: no recorded start for world %s; run start first\n' "${world_id}" >&2
    exit 1
  }
  host_id="$(jq -r '.placed.hostId' <<<"${started}")"
  slot="$(jq -r '.placed.slot' <<<"${started}")"
  # The same command shape the machines send, with the same environment.
  command_id="$(aws_json ssm send-command --instance-ids "${host_id}" --document-name AWS-RunShellScript \
    --comment "spawnpoint acceptance tick ${world_id}" \
    --parameters "$(jq -cn --arg world "${world_id}" --arg slot "${slot}" \
      '{commands: ["set -euo pipefail", "WORLD_ID=\($world) SPAWNPOINT_SLOT=\($slot) SPAWNPOINT_ACCEPT_ACHIEVEMENT_LOSS=1 /srv/spawnpoint/app/server/scripts/measure-tick.sh"]}')" \
    | jq -r '.Command.CommandId')"
  while true; do
    invocation="$(aws_json ssm get-command-invocation --command-id "${command_id}" --instance-id "${host_id}")"
    status="$(jq -r .Status <<<"${invocation}")"
    [[ "${status}" == "Pending" || "${status}" == "InProgress" || "${status}" == "Delayed" ]] || break
    sleep "${poll_seconds}"
  done
  output="$(jq -r '.StandardOutputContent // ""' <<<"${invocation}")"
  local neighbours
  neighbours="$(host_record "${host_id}" | jq '(.reservations | length) - 1' 2>/dev/null || printf 'null')"
  record_event "$(jq -cn --arg world "${world_id}" --arg hostId "${host_id}" --arg slot "${slot}" \
    --arg status "${status}" --arg output "${output}" --argjson neighbours "${neighbours}" '
    ($output | split("\n") | map(select(contains("="))) | map(split("=") | {key: .[0], value: (.[1:] | join("="))}) | from_entries) as $kv
    | {event: "tick", world: $world, hostId: $hostId, slot: ($slot | tonumber? // $slot), commandStatus: $status,
       tickMs: ($kv.tick_ms // null | tonumber? // .), playersOnline: ($kv.players_online // null | tonumber? // .),
       sampledAt: ($kv.sampled_at // null), neighbours: $neighbours}')"
  [[ "${status}" == "Success" ]]
}

# --- stop: the exact session, and what the host looked like once it left ---
cmd_stop() {
  local world_id=""
  while (( $# > 0 )); do
    case "$1" in
      --world) world_id="${2:-}"; shift 2 ;;
      --record) record_dir="${2:-}"; shift 2 ;;
      *) usage ;;
    esac
  done
  [[ -n "${world_id}" ]] || usage
  local started server_id session_id host_id operation_id input arn execution_arn execution host
  started="$(jq -cs --arg world "${world_id}" 'map(select(.event == "start" and .world == $world)) | last // empty' "$(events_file)")"
  [[ -n "${started}" ]] || {
    printf 'error: no recorded start for world %s; run start first\n' "${world_id}" >&2
    exit 1
  }
  server_id="$(jq -r .serverId <<<"${started}")"
  session_id="$(jq -r .sessionId <<<"${started}")"
  host_id="$(jq -r '.placed.hostId' <<<"${started}")"
  operation_id="accept-stop-$(date -u +%Y%m%dT%H%M%SZ)-$(od -An -N2 -tx1 /dev/urandom | tr -d ' \n')"
  input="$(jq -cn --arg serverId "${server_id}" --arg operationId "${operation_id}" --arg sessionId "${session_id}" \
    --arg instanceId "${host_id}" --arg worldId "${world_id}" --argjson timing "$(timing_json)" \
    '{serverId: $serverId, operationId: $operationId, sessionId: $sessionId, leaseTtlSeconds: 1800,
      instanceId: $instanceId, worldId: $worldId, stopTiming: $timing.stopTiming}')"
  arn="$(state_machine_arn spawnpoint-stop-server-v2)"
  execution_arn="$(aws_json stepfunctions start-execution --state-machine-arn "${arn}" --name "${operation_id}" --input "${input}" | jq -r .executionArn)"
  printf 'execution_arn=%s\n' "${execution_arn}" >&2
  execution="$(follow_execution "${execution_arn}")"
  host="$(host_record "${host_id}" || printf 'null')"
  [[ -n "${host}" ]] || host="null"
  record_event "$(jq -cn --arg world "${world_id}" --arg sessionId "${session_id}" --arg hostId "${host_id}" \
    --arg executionArn "${execution_arn}" --argjson execution "${execution}" --argjson host "${host}" \
    '{event: "stop", world: $world, sessionId: $sessionId, hostId: $hostId, executionArn: $executionArn,
      status: $execution.status, requestedAt: $execution.startDate, releasedAt: ($execution.stopDate // null),
      hostStateAfter: ($host.state // null), sessionsLeftOnHost: (if $host then ($host.reservations | length) else null end),
      error: ($execution.error // null)}')"
  [[ "$(jq -r .status <<<"${execution}")" == "SUCCEEDED" ]]
}

# --- drain: wait for the host record to move, then read the drain's minutes ---
cmd_drain() {
  local host_id="" timeout_seconds=1800
  while (( $# > 0 )); do
    case "$1" in
      --host) host_id="${2:-}"; shift 2 ;;
      --timeout-seconds) timeout_seconds="${2:-}"; shift 2 ;;
      --record) record_dir="${2:-}"; shift 2 ;;
      *) usage ;;
    esac
  done
  [[ "${host_id}" =~ ^i-[0-9a-f]+$ ]] || usage
  local waited=0 host state reservations
  while true; do
    host="$(host_record "${host_id}" || printf 'null')"
    state="$(jq -r '.state // "unknown"' <<<"${host:-null}")"
    reservations="$(jq -r '.reservations | length' <<<"${host:-null}" 2>/dev/null || printf 0)"
    printf 'host_state=%s sessions=%s\n' "${state}" "${reservations}" >&2
    [[ "${state}" == "draining" && "${reservations}" == "0" ]] || break
    (( waited < timeout_seconds )) || break
    sleep "${poll_seconds}"
    waited=$((waited + poll_seconds))
  done

  local arn executions execution_arn history drain
  arn="$(state_machine_arn spawnpoint-drain-host-v2)"
  executions="$(aws_json stepfunctions list-executions --state-machine-arn "${arn}" --max-results 50)"
  execution_arn=""
  while IFS= read -r candidate; do
    [[ -n "${candidate}" ]] || continue
    if aws_json stepfunctions describe-execution --execution-arn "${candidate}" \
      | jq -e --arg hostId "${host_id}" '(.input | fromjson | .hostId) == $hostId' >/dev/null; then
      execution_arn="${candidate}"
      break
    fi
  done < <(jq -r '.executions | sort_by(.startDate) | reverse | .[].executionArn' <<<"${executions}")

  drain="null"
  if [[ -n "${execution_arn}" ]]; then
    history="$(execution_history "${execution_arn}")"
    drain="$(jq -cn --arg executionArn "${execution_arn}" --argjson history "${history}" '
      ($history.events) as $events
      | ($events | map(select(.type == "WaitStateEntered" and .stateEnteredEventDetails.name == "Wait Out Grace Period")) | first) as $grace
      | ($events | map(select(.type == "TaskStateExited" and (.stateExitedEventDetails.name == "Terminate Host" or .stateExitedEventDetails.name == "Stop Host"))) | first) as $letGo
      | ($events | map(select(.type == "PassStateExited" and (.stateExitedEventDetails.name | IN("Drained", "Host Taken Back", "Host Already Let Go")))) | first) as $end
      | {executionArn: $executionArn,
         graceStartedAt: ($grace.timestamp // null),
         letGoAt: ($letGo.timestamp // null),
         letGoBy: ($letGo.stateExitedEventDetails.name // null),
         ending: ($end.stateExitedEventDetails.name // null)}')"
  fi
  local last_stop
  last_stop="$(jq -cs --arg hostId "${host_id}" 'map(select(.event == "stop" and .hostId == $hostId)) | last // {}' "$(events_file)" 2>/dev/null || printf '{}')"
  record_event "$(jq -cn --arg hostId "${host_id}" --arg hostState "${state}" --arg instanceState "$(instance_state "${host_id}")" \
    --argjson drain "${drain}" --argjson lastStop "${last_stop}" --argjson host "${host:-null}" \
    '{event: "drain", hostId: $hostId, hostState: $hostState, provenance: ($host.provenance // null), instanceState: $instanceState,
      lastReleasedAt: ($lastStop.releasedAt // null)} + ($drain // {})')"
}

# --- join: what a player saw, in their words ---
cmd_join() {
  local world_id="" kind="" player="" note=""
  while (( $# > 0 )); do
    case "$1" in
      --world) world_id="${2:-}"; shift 2 ;;
      --kind) kind="${2:-}"; shift 2 ;;
      --player) player="${2:-}"; shift 2 ;;
      --note) note="${2:-}"; shift 2 ;;
      --record) record_dir="${2:-}"; shift 2 ;;
      *) usage ;;
    esac
  done
  [[ -n "${world_id}" && -n "${player}" ]] || usage
  [[ "${kind}" == "srv" || "${kind}" == "host-port" ]] || usage
  local address
  address="$(jq -rs --arg world "${world_id}" 'map(select(.event == "start" and .world == $world)) | last | .connectionAddress // "unknown"' "$(events_file)" 2>/dev/null || printf 'unknown')"
  record_event "$(jq -cn --arg world "${world_id}" --arg kind "${kind}" --arg player "${player}" --arg note "${note}" --arg address "${address}" \
    '{event: "join", world: $world, kind: $kind, player: $player, note: $note, address: $address, recordedAt: (now | todate)}')"
}

# --- report: the record as the rollout asks for it ---
cmd_report() {
  local out=""
  while (( $# > 0 )); do
    case "$1" in
      --out) out="${2:-}"; shift 2 ;;
      --record) record_dir="${2:-}"; shift 2 ;;
      *) usage ;;
    esac
  done
  [[ -f "$(events_file)" ]] || {
    printf 'error: no record at %s\n' "$(events_file)" >&2
    exit 1
  }
  local report
  report="$(jq -rs '
    def row: map(tostring) | join(" | ") | "| " + . + " |";
    def or_blank: if . == null then "—" else . end;
    def minute: if . == null then "—" else (sub("\\.[0-9]+"; "") | sub("\\+00:00$"; "Z")) end;
    (map(select(.event == "start"))) as $starts
    | (map(select(.event == "tick"))) as $ticks
    | (map(select(.event == "stop"))) as $stops
    | (map(select(.event == "drain"))) as $drains
    | (map(select(.event == "join"))) as $joins
    | [
      "# Capacity allocation acceptance (ADR-0054, phase 10)",
      "",
      "Recorded by `scripts/acceptance-capacity-allocation.sh`; every figure below is read from an execution history, a host record or a host command, never typed in. Generated " + (now | todate) + ".",
      "",
      "## Milliseconds per tick, alone and beside a neighbour",
      "",
      "| World | Host | Slot | Players | Neighbours | ms/tick | Sampled |",
      "| --- | --- | --- | --- | --- | --- | --- |",
      ($ticks[] | [.world, .hostId, .slot, (.playersOnline | or_blank), (.neighbours | or_blank), (.tickMs | or_blank), (.sampledAt | or_blank)] | row),
      (if ($ticks | length) == 0 then "| — | — | — | — | — | — | not measured yet |" else empty end),
      "",
      "A row with neighbours 0 is the world alone; a row for the same world with neighbours above 0 is the co-tenant figure the core weight rests on.",
      "",
      "## Starts, and the second session on a host that is already up",
      "",
      "| World | Result | Placement | Host | Slot | Neighbours at start | Requested | Ready | Seconds to ready | Launched as |",
      "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
      ($starts[] | [.world, .status, .placement, (.placed.hostId | or_blank), (.placed.slot | or_blank), (.neighboursAtStart | or_blank), (.requestedAt | minute), (.readyAt | minute), (.secondsToReady | or_blank), (if .launched then (.launched.instanceType // .launched.instanceId // "—") else "—" end)] | row),
      (if ($starts | length) == 0 then "| — | — | — | — | — | — | — | — | — | — |" else empty end),
      "",
      "## Stops",
      "",
      "| World | Result | Host | Released | Sessions left on host | Host state after |",
      "| --- | --- | --- | --- | --- | --- |",
      ($stops[] | [.world, .status, .hostId, (.releasedAt | minute), (.sessionsLeftOnHost | or_blank), (.hostStateAfter | or_blank)] | row),
      (if ($stops | length) == 0 then "| — | — | — | — | — | — |" else empty end),
      "",
      "## Drains",
      "",
      "| Host | Provenance | Last session released | Grace started | Let go | By | Ending | Instance state |",
      "| --- | --- | --- | --- | --- | --- | --- | --- |",
      ($drains[] | [.hostId, (.provenance | or_blank), (.lastReleasedAt | minute), (.graceStartedAt | minute), (.letGoAt | minute), (.letGoBy | or_blank), (.ending | or_blank), .instanceState] | row),
      (if ($drains | length) == 0 then "| — | — | — | — | — | — | — | — |" else empty end),
      "",
      "Nothing billed after: the day after a terminate, run the command below for the day of the drain and the day after; the launched host is the only thing tagged so, and the second day must show nothing.",
      "",
      "```bash",
      "aws ce get-cost-and-usage --time-period Start=<drain-day>,End=<two-days-later> --granularity DAILY --metrics UnblendedCost --filter '"'"'{\"Tags\":{\"Key\":\"ManagedBy\",\"Values\":[\"spawnpoint-fleet\"]}}'"'"' --profile spawnpoint",
      "```",
      "",
      "## Joins, by a player who was not told which they were using",
      "",
      "| World | Kind | Player | Address | Note | Recorded |",
      "| --- | --- | --- | --- | --- | --- |",
      ($joins[] | [.world, .kind, .player, .address, (.note | if . == "" then "—" else . end), (.recordedAt | minute)] | row),
      (if ($joins | length) == 0 then "| — | — | — | — | — | not recorded yet |" else empty end),
      "",
      "No `SRV` join can be recorded until a Route 53 strategy exists on the host; every join today is `host-port`."
    ] | .[]' "$(events_file)")"
  if [[ -n "${out}" ]]; then
    mkdir -p -- "$(dirname -- "${out}")"
    printf '%s\n' "${report}" >"${out}"
    printf 'report=%s\n' "${out}"
  else
    printf '%s\n' "${report}"
  fi
}

(( $# > 0 )) || usage
command_name="$1"
shift
# --record may come before or after the command's own options.
case "${command_name}" in
  start) cmd_start "$@" ;;
  tick) cmd_tick "$@" ;;
  stop) cmd_stop "$@" ;;
  drain) cmd_drain "$@" ;;
  join) cmd_join "$@" ;;
  report) cmd_report "$@" ;;
  *) usage ;;
esac
