#!/usr/bin/env bash

set -Eeuo pipefail

root="${1:?usage: terraform-init-ci.sh <terraform-root>}"
repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
root_path="${repository_root}/${root}"
backend_example="${root_path}/backend.hcl.example"

[[ -d "${root_path}" && -f "${backend_example}" ]] || {
  printf 'error: %s is not a remote-state Terraform root\n' "${root}" >&2
  exit 1
}

state_key="$(sed -nE 's/^key[[:space:]]*=[[:space:]]*"([^"]+)".*/\1/p' "${backend_example}")"
[[ -n "${state_key}" ]] || {
  printf 'error: no backend key in %s\n' "${backend_example}" >&2
  exit 1
}

aws_region="${AWS_REGION:-eu-central-1}"
state_bucket="${TF_STATE_BUCKET:-}"
if [[ -z "${state_bucket}" ]]; then
  account_id="$(aws sts get-caller-identity --query Account --output text)"
  state_bucket="spawnpoint-tfstate-${account_id}"
fi

terraform -chdir="${root_path}" init -input=false -reconfigure \
  -backend-config="bucket=${state_bucket}" \
  -backend-config="key=${state_key}" \
  -backend-config="region=${aws_region}" \
  -backend-config="encrypt=true" \
  -backend-config="use_lockfile=true"
