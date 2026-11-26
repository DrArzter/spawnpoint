#!/usr/bin/env bash
# Send one Spot interruption to the host of one test world (ADR-0102, step 7).
#
#   scripts/spot-fault-test.sh <world-id>         read only: say what would be interrupted
#   scripts/spot-fault-test.sh <world-id> --run   ask for "yes", arm that host, start FIS
#
# It refuses unless the world's session is ready, its session volume is
# attached to a running launched host, and that host is on Spot. It prints
# key=value lines; every branch prints the same keys.

set -Eeuo pipefail

aws_cli="${SPAWNPOINT_AWS_CLI:-aws}"
profile="${AWS_PROFILE:-spawnpoint}"
table="${SPAWNPOINT_LIFECYCLE_TABLE:-spawnpoint-lifecycle-v2}"
readonly TEMPLATE_NAME="spawnpoint-spot-interruption"

world_id="${1:-}"
mode="${2:-dry-run}"
[[ "${world_id}" =~ ^[a-z0-9][a-z0-9-]{0,31}$ && ("${mode}" == "dry-run" || "${mode}" == "--run") ]] || {
  printf 'usage: %s <world-id> [--run]\n' "$0" >&2
  exit 2
}
[[ "${profile}" != "default" ]] || {
  printf 'error: refusing the default AWS profile; use spawnpoint\n' >&2
  exit 2
}

session="" host="" market="" volume="" address="" experiment=""
report() {
  printf 'result=%s\nworld=%s\nsession=%s\nhost=%s\nmarket=%s\nvolume=%s\naddress=%s\nexperiment=%s\n' \
    "$1" "${world_id}" "${session}" "${host}" "${market}" "${volume}" "${address}" "${experiment}"
}
refuse() {
  printf 'refused: %s\n' "$2" >&2
  report "$1"
  exit 1
}
aws_json() {
  "${aws_cli}" --profile "${profile}" --output json "$@"
}

record="$(aws_json dynamodb get-item --table-name "${table}" --consistent-read \
  --key "{\"server_id\":{\"S\":\"world#${world_id}\"}}")"
state="$(jq -r '.Item.lifecycle.M.observedState.S // "absent"' <<<"${record}")"
session="$(jq -r '.Item.lifecycle.M.activeSessionId.S // ""' <<<"${record}")"
address="$(jq -r '.Item.lifecycle.M.activeSessionAddress.S // ""' <<<"${record}")"
[[ "${state}" == "ready" && -n "${session}" ]] || refuse not_ready "the world's session is ${state}, not ready"

volumes="$(aws_json ec2 describe-volumes --filters "Name=tag:SessionId,Values=${session}" "Name=tag:ManagedBy,Values=spawnpoint-session-volume")"
volume="$(jq -r '.Volumes[0].VolumeId // ""' <<<"${volumes}")"
host="$(jq -r '.Volumes[0].Attachments[0].InstanceId // ""' <<<"${volumes}")"
[[ -n "${volume}" && -n "${host}" ]] || refuse no_volume "the session has no attached session volume"

instance="$(aws_json ec2 describe-instances --instance-ids "${host}")"
market="$(jq -r '.Reservations[0].Instances[0].InstanceLifecycle // "on-demand"' <<<"${instance}")"
fleet="$(jq -r '[.Reservations[0].Instances[0].Tags[]? | select(.Key == "ManagedBy") | .Value][0] // ""' <<<"${instance}")"
running="$(jq -r '.Reservations[0].Instances[0].State.Name // ""' <<<"${instance}")"
[[ "${fleet}" == "spawnpoint-fleet" && "${running}" == "running" ]] || refuse not_fleet "host ${host} is not a running launched host"
[[ "${market}" == "spot" ]] || refuse not_spot "host ${host} is on demand; FIS can interrupt only Spot"

if [[ "${mode}" != "--run" ]]; then
  report dry_run
  exit 0
fi

printf 'Interrupt %s (world %s, session %s)? Players are disconnected until it is back. Type yes: ' \
  "${host}" "${world_id}" "${session}" >&2
read -r answer || answer=""
[[ "${answer}" == "yes" ]] || refuse cancelled "not confirmed"

template="$(aws_json fis list-experiment-templates \
  | jq -r --arg name "${TEMPLATE_NAME}" '[.experimentTemplates[] | select(.tags.Name == $name) | .id][0] // ""')"
[[ -n "${template}" ]] || refuse no_template "no FIS template; turn on SPAWNPOINT_SPOT_FAULT_TEST and deploy"

"${aws_cli}" --profile "${profile}" ec2 create-tags --resources "${host}" --tags Key=SpawnpointFaultTarget,Value=armed
experiment="$(aws_json fis start-experiment --experiment-template-id "${template}" \
  --tags "Name=spawnpoint-spot-fault-test,WorldId=${world_id}" | jq -r '.experiment.id // ""')"
[[ -n "${experiment}" ]] || refuse not_started "FIS did not start the experiment"
report started
