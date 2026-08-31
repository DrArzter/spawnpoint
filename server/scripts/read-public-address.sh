#!/usr/bin/env bash

# Print this instance's public IPv4, read from the instance metadata service.
#
# IMDSv2 only: a token is requested first, and the hop limit of one that the
# host root configures means this answers the host and refuses a container. So
# a compromised game server cannot use this to discover anything, and nothing
# here needs an AWS credential.

set -Eeuo pipefail

metadata_base="${IMDS_BASE:-http://169.254.169.254}"
timeout_seconds="${IMDS_TIMEOUT_SECONDS:-2}"

command -v curl >/dev/null 2>&1 || {
  printf 'error: curl is not installed\n' >&2
  exit 1
}

token="$(curl -fsS -m "${timeout_seconds}" -X PUT \
  -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' \
  "${metadata_base}/latest/api/token")" || {
  printf 'error: instance metadata did not issue a token; IMDSv2 is required\n' >&2
  exit 1
}

address="$(curl -fsS -m "${timeout_seconds}" \
  -H "X-aws-ec2-metadata-token: ${token}" \
  "${metadata_base}/latest/meta-data/public-ipv4")" || {
  # A stopped-and-started instance without a public IPv4 is a configuration
  # answer, not a transient one: publishing nothing is better than publishing
  # an address nobody can reach.
  printf 'error: this instance has no public IPv4 address\n' >&2
  exit 1
}

[[ "${address}" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || {
  printf 'error: instance metadata returned something that is not an IPv4 address\n' >&2
  exit 1
}

printf '%s\n' "${address}"
