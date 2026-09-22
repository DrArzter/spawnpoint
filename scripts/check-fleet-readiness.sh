#!/usr/bin/env bash

# Fail before Terraform mutates production when a launched host could not
# bootstrap. Values are deliberately never printed: only missing parameter
# names are safe deployment diagnostics.

set -Eeuo pipefail

aws_cli="${SPAWNPOINT_AWS_CLI:-aws}"
required_parameters=(
  /spawnpoint/host/env/CF_API_KEY
  /spawnpoint/host/env/RCON_PASSWORD
  /spawnpoint/host/env/GRAFANA_ADMIN_PASSWORD
  /spawnpoint/host/env/BACKUP_BUCKET
  /spawnpoint/host/env/RELEASE_BUCKET
  /spawnpoint/host/env/AWS_REGION
)

missing=()
for parameter in "${required_parameters[@]}"; do
  if ! "${aws_cli}" ssm get-parameter \
    --name "${parameter}" \
    --with-decryption \
    --query 'Parameter.Name' \
    --output text >/dev/null 2>&1; then
    missing+=("${parameter}")
  fi
done

if (( ${#missing[@]} > 0 )); then
  printf 'fleet launch is not ready; missing or unreadable SSM parameters:\n' >&2
  printf '  %s\n' "${missing[@]}" >&2
  exit 1
fi

printf 'fleet launch prerequisites: %d SSM parameters readable\n' "${#required_parameters[@]}"
