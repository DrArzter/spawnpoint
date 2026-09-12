#!/usr/bin/env bash

set -Eeuo pipefail

root="${1:?usage: terraform-apply-safe.sh <terraform-root>}"
repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
root_path="${repository_root}/${root}"
plan_file="${root_path}/production.tfplan"

"${repository_root}/scripts/terraform-init-ci.sh" "${root}"
terraform -chdir="${root_path}" plan -input=false -out="${plan_file}"

plan_json="$(terraform -chdir="${root_path}" show -json "${plan_file}")"
if jq -e '[.resource_changes[]? | select(.change.actions != ["no-op"])] | length == 0' >/dev/null <<<"${plan_json}"; then
  printf 'result=unchanged\nroot=%s\n' "${root}"
  exit 0
fi

if jq -e 'any(.resource_changes[]?; .change.actions | index("delete") != null)' >/dev/null <<<"${plan_json}"; then
  printf 'error: %s contains a delete or replacement; automatic apply refused\n' "${root}" >&2
  terraform -chdir="${root_path}" show -no-color "${plan_file}" >&2
  exit 1
fi

terraform -chdir="${root_path}" apply -input=false -auto-approve "${plan_file}"
printf 'result=deployed\nroot=%s\n' "${root}"
