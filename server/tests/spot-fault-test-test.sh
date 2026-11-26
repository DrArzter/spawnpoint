#!/usr/bin/env bash

# scripts/spot-fault-test.sh against a fake aws: a dry run only reads; a run
# needs "yes", arms the one host and starts the experiment; a session that is
# not ready, or a host on demand, is refused before anything is written.

set -Eeuo pipefail

repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
script="${repository_root}/scripts/spot-fault-test.sh"
work="$(mktemp -d)"
trap 'rm -rf -- "${work}"' EXIT

cat >"${work}/aws" <<'FAKE'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"${FAKE_LOG}"
case "$*" in
  *"dynamodb get-item"*) printf '{"Item":{"lifecycle":{"M":{"observedState":{"S":"%s"},"activeSessionId":{"S":"s1"},"activeSessionAddress":{"S":"alpha.example.test:25565"}}}}}\n' "${FAKE_STATE:-ready}" ;;
  *"ec2 describe-volumes"*) printf '{"Volumes":[{"VolumeId":"vol-0123456789abcdef0","Attachments":[{"InstanceId":"i-0123456789abcdef0"}]}]}\n' ;;
  *"ec2 describe-instances"*) printf '{"Reservations":[{"Instances":[{"InstanceLifecycle":"%s","State":{"Name":"running"},"Tags":[{"Key":"ManagedBy","Value":"spawnpoint-fleet"}]}]}]}\n' "${FAKE_MARKET:-spot}" ;;
  *"fis list-experiment-templates"*) printf '{"experimentTemplates":[{"id":"EXT123","tags":{"Name":"spawnpoint-spot-interruption"}}]}\n' ;;
  *"fis start-experiment"*) printf '{"experiment":{"id":"EXP456"}}\n' ;;
  *"ec2 create-tags"*) ;;
  *) exit 1 ;;
esac
FAKE
chmod +x "${work}/aws"
export SPAWNPOINT_AWS_CLI="${work}/aws" FAKE_LOG="${work}/calls"
writes='create-tags|start-experiment'

# Malformed arguments and the default profile are refused before any call.
for args in "" "Alpha" "alpha --now"; do
  # shellcheck disable=SC2086 # the cases are word lists on purpose
  if "${script}" ${args} >/dev/null 2>&1; then exit 1; fi
done
if AWS_PROFILE=default "${script}" alpha >/dev/null 2>&1; then exit 1; fi
[[ ! -e "${FAKE_LOG}" ]]

# A dry run reads and says what it would interrupt.
output="$("${script}" alpha)"
grep -qx 'result=dry_run' <<<"${output}"
grep -qx 'host=i-0123456789abcdef0' <<<"${output}"
grep -qx 'volume=vol-0123456789abcdef0' <<<"${output}"
grep -qx 'market=spot' <<<"${output}"
grep -qx 'experiment=' <<<"${output}"
if grep -Eq "${writes}" "${FAKE_LOG}"; then exit 1; fi
grep -q -- '--profile spawnpoint' "${FAKE_LOG}"

# Not ready, or on demand: refused, nothing written.
: >"${FAKE_LOG}"
if output="$(FAKE_STATE=moving "${script}" alpha --run </dev/null 2>/dev/null)"; then exit 1; fi
grep -qx 'result=not_ready' <<<"${output}"
if output="$(FAKE_MARKET=on-demand "${script}" alpha --run </dev/null 2>/dev/null)"; then exit 1; fi
grep -qx 'result=not_spot' <<<"${output}"
if grep -Eq "${writes}" "${FAKE_LOG}"; then exit 1; fi

# A run without "yes" writes nothing; with it, arms the host and starts FIS.
if output="$(printf 'no\n' | "${script}" alpha --run 2>/dev/null)"; then exit 1; fi
grep -qx 'result=cancelled' <<<"${output}"
if grep -Eq "${writes}" "${FAKE_LOG}"; then exit 1; fi
output="$(printf 'yes\n' | "${script}" alpha --run 2>/dev/null)"
grep -qx 'result=started' <<<"${output}"
grep -qx 'experiment=EXP456' <<<"${output}"
grep -q 'ec2 create-tags --resources i-0123456789abcdef0 --tags Key=SpawnpointFaultTarget,Value=armed' "${FAKE_LOG}"
grep -q 'fis start-experiment --experiment-template-id EXT123' "${FAKE_LOG}"

printf 'spot fault test script tests passed\n'
