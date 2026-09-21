#!/usr/bin/env bash

# scripts/acceptance-capacity-allocation.sh against a fake aws: the record it
# writes is read from execution histories, host records and a host command,
# and the report is rendered from that record. Canned answers stand in for the
# deployment; what is tested is that the harness asks the right questions and
# copies the answers faithfully.

set -Eeuo pipefail

repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
harness="${repository_root}/scripts/acceptance-capacity-allocation.sh"
fixture="$(mktemp -d /tmp/spawnpoint-acceptance-harness-test.XXXXXXXX)"
cleanup() {
  rm -rf -- "${fixture}"
}
trap cleanup EXIT

mkdir -p -- "${fixture}/bin"
cat >"${fixture}/bin/aws" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
printf '%s\n' "$*" >>"${FAKE_AWS_CALLS}"
declare -A flag
positional=()
while (( $# > 0 )); do
  case "$1" in
    --profile | --region | --output | --cli-binary-format) shift 2 ;;
    --include-execution-data) shift ;;
    --*) flag["${1#--}"]="${2:-}"; shift 2 ;;
    *) positional+=("$1"); shift ;;
  esac
done
account="arn:aws:states:eu-central-1:123456789012"
machine_of() { sed -E 's/^.*:execution:([^:]+):.*$/\1/' <<<"$1"; }
case "${positional[0]} ${positional[1]}" in
  "stepfunctions list-state-machines")
    jq -n --arg a "${account}" '{stateMachines: [
      {name: "spawnpoint-start-server-v2", stateMachineArn: ($a + ":stateMachine:spawnpoint-start-server-v2")},
      {name: "spawnpoint-stop-server-v2", stateMachineArn: ($a + ":stateMachine:spawnpoint-stop-server-v2")},
      {name: "spawnpoint-drain-host-v2", stateMachineArn: ($a + ":stateMachine:spawnpoint-drain-host-v2")}]}'
    ;;
  "stepfunctions start-execution")
    machine="${flag[state-machine-arn]##*:}"
    printf '%s\n' "${flag[input]}" >"${FAKE_AWS_DIR}/input-${flag[name]}.json"
    jq -n --arg arn "${account}:execution:${machine}:${flag[name]}" '{executionArn: $arn, startDate: "2026-09-17T18:00:00.123000+00:00"}'
    ;;
  "stepfunctions describe-execution")
    case "$(machine_of "${flag[execution-arn]}")" in
      spawnpoint-start-server-v2)
        jq -n --arg arn "${flag[execution-arn]}" '{executionArn: $arn, status: "SUCCEEDED", startDate: "2026-09-17T18:00:00.123000+00:00", stopDate: "2026-09-17T18:02:40.000000+00:00", output: ({connectionAddress: "172.29.23.24:30010"} | tojson)}' ;;
      spawnpoint-stop-server-v2)
        jq -n --arg arn "${flag[execution-arn]}" '{executionArn: $arn, status: "SUCCEEDED", startDate: "2026-09-17T19:00:00.000000+00:00", stopDate: "2026-09-17T19:03:00.500000+00:00", output: "{}"}' ;;
      spawnpoint-drain-host-v2)
        jq -n --arg arn "${flag[execution-arn]}" '{executionArn: $arn, status: "SUCCEEDED", startDate: "2026-09-17T19:03:05.000000+00:00", stopDate: "2026-09-17T19:13:30.000000+00:00", input: ({hostId: "i-1a0c4ed0", emptiedBy: "session-x"} | tojson)}' ;;
    esac
    ;;
  "stepfunctions get-execution-history")
    case "$(machine_of "${flag[execution-arn]}")" in
      spawnpoint-start-server-v2)
        jq -n --arg host "${FAKE_PLACED_HOST}" --argjson slot "${FAKE_PLACED_SLOT}" --arg launch "${FAKE_LAUNCH:-}" '{events: ([
          {timestamp: "2026-09-17T18:00:01.000000+00:00", type: "TaskStateExited", stateExitedEventDetails: {name: "Place Session", output: "{}"}},
          (if $launch == "1" then
            {timestamp: "2026-09-17T18:00:30.000000+00:00", type: "TaskStateExited", stateExitedEventDetails: {name: "Launch Host", output: ({Instances: [{InstanceIds: ["i-1a0c4ed0"]}]} | tojson)}},
            {timestamp: "2026-09-17T18:00:31.000000+00:00", type: "TaskStateExited", stateExitedEventDetails: {name: "Describe Launched Host Shape", output: ({InstanceTypes: [{InstanceType: "m7i.large"}]} | tojson)}}
          else empty end),
          {timestamp: "2026-09-17T18:00:32.000000+00:00", type: "PassStateExited", stateExitedEventDetails: {name: "Adopt Placement", output: ({request: {placed: {hostId: $host, slot: $slot}}} | tojson)}},
          {timestamp: "2026-09-17T18:02:30.250000+00:00", type: "TaskStateExited", stateExitedEventDetails: {name: "Mark Session Ready", output: "{}"}}
        ])}' ;;
      spawnpoint-drain-host-v2)
        jq -n '{events: [
          {timestamp: "2026-09-17T19:03:10.000000+00:00", type: "WaitStateEntered", stateEnteredEventDetails: {name: "Wait Out Grace Period"}},
          {timestamp: "2026-09-17T19:13:20.000000+00:00", type: "TaskStateExited", stateExitedEventDetails: {name: "Terminate Host", output: "{}"}},
          {timestamp: "2026-09-17T19:13:21.000000+00:00", type: "PassStateExited", stateExitedEventDetails: {name: "Drained", output: "{}"}}
        ]}' ;;
    esac
    ;;
  "stepfunctions list-executions")
    jq -n --arg a "${account}" '{executions: [{executionArn: ($a + ":execution:spawnpoint-drain-host-v2:d1"), startDate: "2026-09-17T19:03:05.000000+00:00"}]}'
    ;;
  "ec2 describe-instances")
    if [[ "${flag[instance-ids]:-}" == "i-1a0c4ed0" ]]; then
      jq -n '{Reservations: [{Instances: [{InstanceId: "i-1a0c4ed0", State: {Name: "terminated"}}]}]}'
    else
      jq -n '{Reservations: [{Instances: [{InstanceId: "i-0c0f19ed", State: {Name: "running"}}]}]}'
    fi
    ;;
  "lambda invoke")
    printf '%s\n' "${flag[payload]}" >>"${FAKE_AWS_DIR}/lambda-payloads"
    jq -n --slurpfile record "${FAKE_HOST_RECORD}" '{host: {version: 3, record: $record[0]}}' >"${positional[2]}"
    jq -n '{StatusCode: 200}'
    ;;
  "ssm send-command")
    printf '%s\n' "${flag[parameters]}" >>"${FAKE_AWS_DIR}/ssm-parameters"
    jq -n '{Command: {CommandId: "cmd-1"}}'
    ;;
  "ssm get-command-invocation")
    jq -n '{Status: "Success", StandardOutputContent: "game=factorio\nworld=base\nslot=1\nplayers_online=2\nsampled_at=2026-09-17T18:30:00Z\ntick_ms=16.667\n"}'
    ;;
  *)
    printf 'fake aws: unexpected call: %s\n' "${positional[*]}" >&2
    exit 64
    ;;
esac
EOF
chmod 0755 "${fixture}/bin/aws"
export PATH="${fixture}/bin:${PATH}"
export FAKE_AWS_DIR="${fixture}"
export FAKE_AWS_CALLS="${fixture}/aws-calls"
export SPAWNPOINT_POLL_SECONDS=0
record="${fixture}/record"

host_record() {
  local file="$1" host="$2" provenance="$3" state="$4"
  shift 4
  jq -n --arg host "${host}" --arg provenance "${provenance}" --arg state "${state}" --args '{
    schemaVersion: 1, hostId: $host, provenance: $provenance, state: $state,
    shape: {instanceType: "m7i-flex.large", memoryMiB: 8192, cores: 2},
    reservations: [$ARGS.positional[] | {sessionId: ("s-" + .), worldId: ., slot: 0, footprint: {memoryMiB: 2048, cores: 0.5}, policy: "cold"}]
  }' "$@" >"${file}"
}

# --- a first session on the configured host, then a second beside it ---
host_record "${fixture}/host-one.json" i-0c0f19ed configured ready world
export FAKE_HOST_RECORD="${fixture}/host-one.json" FAKE_PLACED_HOST=i-0c0f19ed FAKE_PLACED_SLOT=0
"${harness}" start --world world --record "${record}" >/dev/null 2>&1
jq -e '.placement == "shared" and .launch == "disabled" and .worldId == "world" and .serverId == "minecraft" and .instanceId == "i-0c0f19ed"' "${fixture}"/input-accept-*.json >/dev/null

host_record "${fixture}/host-two.json" i-0c0f19ed configured ready world base
export FAKE_HOST_RECORD="${fixture}/host-two.json" FAKE_PLACED_SLOT=1
"${harness}" start --world base --game factorio --record "${record}" >/dev/null 2>&1
jq -e '.serverId == "factorio" and .worldId == "base"' "$(ls -t "${fixture}"/input-accept-2*.json | head -n1)" >/dev/null
# A world the catalog does not know needs its game named.
if "${harness}" start --world unknown-world --record "${record}" >/dev/null 2>&1; then exit 1; fi
second="$(jq -cs 'map(select(.event == "start" and .world == "base")) | last' "${record}/events.jsonl")"
jq -e '.status == "SUCCEEDED" and .placement == "reuse" and .placed.hostId == "i-0c0f19ed" and .placed.slot == 1
  and .secondsToReady == 150 and .neighboursAtStart == 1 and .connectionAddress == "172.29.23.24:30010" and .launched == null' <<<"${second}" >/dev/null
first="$(jq -cs 'map(select(.event == "start" and .world == "world")) | last' "${record}/events.jsonl")"
jq -e '.neighboursAtStart == 0' <<<"${first}" >/dev/null

# --- the tick reading runs on the session's host with the session's slot ---
"${harness}" tick --world base --record "${record}" >/dev/null 2>&1
grep -Fq 'WORLD_ID=base SPAWNPOINT_SLOT=1 SPAWNPOINT_ACCEPT_ACHIEVEMENT_LOSS=1 /srv/spawnpoint/app/server/scripts/measure-tick.sh' "${fixture}/ssm-parameters"
tick="$(jq -cs 'map(select(.event == "tick")) | last' "${record}/events.jsonl")"
jq -e '.world == "base" and .hostId == "i-0c0f19ed" and .slot == 1 and .tickMs == 16.667 and .playersOnline == 2 and .neighbours == 1 and .commandStatus == "Success"' <<<"${tick}" >/dev/null

# --- the stop names the exact session and reads what the host looked like after ---
host_record "${fixture}/host-after.json" i-0c0f19ed configured ready world
export FAKE_HOST_RECORD="${fixture}/host-after.json"
"${harness}" stop --world base --record "${record}" >/dev/null 2>&1
jq -e '.sessionId == "session-accept-'"$(jq -r .operationId <<<"${second}" | sed 's/^accept-//')"'" and .instanceId == "i-0c0f19ed" and .worldId == "base" and .serverId == "factorio"' "${fixture}"/input-accept-stop-*.json >/dev/null
stop="$(jq -cs 'map(select(.event == "stop")) | last' "${record}/events.jsonl")"
jq -e '.status == "SUCCEEDED" and .sessionsLeftOnHost == 1 and .hostStateAfter == "ready" and .releasedAt == "2026-09-17T19:03:00.500000+00:00"' <<<"${stop}" >/dev/null

# --- a launch, its stop, and the drain that lets the host go ---
host_record "${fixture}/host-launched.json" i-1a0c4ed0 launched ready vanilla
export FAKE_HOST_RECORD="${fixture}/host-launched.json" FAKE_PLACED_HOST=i-1a0c4ed0 FAKE_PLACED_SLOT=0 FAKE_LAUNCH=1
"${harness}" start --world vanilla --launch enabled --record "${record}" >/dev/null 2>&1
jq -e '.launch == "enabled" and .serverId == "minecraft"' "$(ls -t "${fixture}"/input-accept-2*.json | head -n1)" >/dev/null
launched="$(jq -cs 'map(select(.event == "start" and .world == "vanilla")) | last' "${record}/events.jsonl")"
jq -e '.placement == "launch" and .launched.instanceId == "i-1a0c4ed0" and .launched.instanceType == "m7i.large" and .placed.hostId == "i-1a0c4ed0"' <<<"${launched}" >/dev/null
unset FAKE_LAUNCH

host_record "${fixture}/host-emptied.json" i-1a0c4ed0 launched draining
export FAKE_HOST_RECORD="${fixture}/host-emptied.json"
"${harness}" stop --world vanilla --record "${record}" >/dev/null 2>&1
host_record "${fixture}/host-gone.json" i-1a0c4ed0 launched terminating
export FAKE_HOST_RECORD="${fixture}/host-gone.json"
"${harness}" drain --host i-1a0c4ed0 --record "${record}" >/dev/null 2>&1
drain="$(jq -cs 'map(select(.event == "drain")) | last' "${record}/events.jsonl")"
jq -e '.hostId == "i-1a0c4ed0" and .provenance == "launched" and .hostState == "terminating" and .instanceState == "terminated"
  and .graceStartedAt == "2026-09-17T19:03:10.000000+00:00" and .letGoAt == "2026-09-17T19:13:20.000000+00:00"
  and .letGoBy == "Terminate Host" and .ending == "Drained" and .lastReleasedAt == "2026-09-17T19:03:00.500000+00:00"' <<<"${drain}" >/dev/null

# --- what a player saw, and the report ---
"${harness}" join --world base --kind host-port --player alice --note "typed it from the panel" --record "${record}" >/dev/null
"${harness}" report --record "${record}" --out "${fixture}/report.md" >/dev/null
grep -Fq '| base | i-0c0f19ed | 1 | 2 | 1 | 16.667 | 2026-09-17T18:30:00Z |' "${fixture}/report.md"
grep -Fq '| base | SUCCEEDED | reuse | i-0c0f19ed | 1 | 1 | 2026-09-17T18:00:00Z | 2026-09-17T18:02:30Z | 150 | — |' "${fixture}/report.md"
grep -Fq '| vanilla | SUCCEEDED | launch | i-1a0c4ed0 | 0 | 0 | 2026-09-17T18:00:00Z | 2026-09-17T18:02:30Z | 150 | m7i.large |' "${fixture}/report.md"
grep -Fq '| base | SUCCEEDED | i-0c0f19ed | 2026-09-17T19:03:00Z | 1 | ready |' "${fixture}/report.md"
grep -Fq '| i-1a0c4ed0 | launched | 2026-09-17T19:03:00Z | 2026-09-17T19:03:10Z | 2026-09-17T19:13:20Z | Terminate Host | Drained | terminated |' "${fixture}/report.md"
grep -Fq '| base | host-port | alice | 172.29.23.24:30010 | typed it from the panel |' "${fixture}/report.md"
grep -Fq 'ManagedBy' "${fixture}/report.md"

# A report with nothing recorded still has every section, with its blanks.
mkdir -p -- "${fixture}/empty"
: >"${fixture}/empty/events.jsonl"
"${harness}" report --record "${fixture}/empty" | grep -Fq 'not measured yet'

printf 'result=passed\n'
