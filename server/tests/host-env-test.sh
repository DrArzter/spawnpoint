#!/usr/bin/env bash

# A launched host renders its .env from Parameter Store (ADR-0054, phase 12);
# the renderer is the one part of that bootstrap that runs without a host.

set -Eeuo pipefail

repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
render="${repository_root}/server/scripts/render-host-env.sh"

expect_failure() {
  local label="$1"
  shift
  if "$@" >/dev/null 2>&1; then
    printf 'expected failure: %s\n' "${label}" >&2
    exit 1
  fi
}

rendered="$("${render}" <<'PARAMETERS'
{"Parameters": [
  {"Name": "/spawnpoint/host/env/RCON_PASSWORD", "Type": "SecureString", "Value": "s3cret=with=equals"},
  {"Name": "/spawnpoint/host/env/AWS_REGION", "Type": "String", "Value": "eu-central-1"},
  {"Name": "/spawnpoint/host/env/ZEROTIER_NETWORK_ID", "Type": "String", "Value": "b6079f73c6698651"}
]}
PARAMETERS
)"
[[ "${rendered}" == $'AWS_REGION=eu-central-1\nRCON_PASSWORD=s3cret=with=equals\nZEROTIER_NETWORK_ID=b6079f73c6698651' ]] || {
  printf 'unexpected rendering:\n%s\n' "${rendered}" >&2
  exit 1
}

expect_failure "lower-case key" "${render}" <<<'{"Parameters":[{"Name":"/spawnpoint/host/env/rcon","Value":"x"}]}'
expect_failure "shell in the key" "${render}" <<<'{"Parameters":[{"Name":"/spawnpoint/host/env/A;rm","Value":"x"}]}'
expect_failure "multi-line value" "${render}" <<<'{"Parameters":[{"Name":"/spawnpoint/host/env/A","Value":"one\ntwo"}]}'
expect_failure "nothing to render" "${render}" <<<'{"Parameters":[]}'

printf 'result=passed\n'
