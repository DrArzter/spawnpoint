#!/usr/bin/env bash

set -Eeuo pipefail

repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
check="${repository_root}/scripts/check-fleet-readiness.sh"
fake_aws="${repository_root}/server/tests/fake-aws-ssm"
work="$(mktemp -d)"
trap 'rm -rf -- "${work}"' EXIT

export SPAWNPOINT_AWS_CLI="${fake_aws}"
export FAKE_AWS_SSM_LOG="${work}/calls"

"${check}" >"${work}/success.out"
[[ "$(wc -l <"${FAKE_AWS_SSM_LOG}")" -eq 8 ]]
grep -Fq '8 SSM parameters readable' "${work}/success.out"

: >"${FAKE_AWS_SSM_LOG}"
export FAKE_AWS_SSM_MISSING=/spawnpoint/host/env/RCON_PASSWORD
if "${check}" >"${work}/failure.out" 2>"${work}/failure.err"; then
  printf 'readiness check unexpectedly accepted a missing parameter\n' >&2
  exit 1
fi
grep -Fq '/spawnpoint/host/env/RCON_PASSWORD' "${work}/failure.err"
[[ "$(wc -l <"${FAKE_AWS_SSM_LOG}")" -eq 8 ]]

printf 'result=passed\n'
