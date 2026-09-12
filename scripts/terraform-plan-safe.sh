#!/usr/bin/env bash

set -Eeuo pipefail

root="${1:?usage: terraform-plan-safe.sh <terraform-root>}"
repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
root_path="${repository_root}/${root}"
plan_file="${root_path}/pull-request.tfplan"
plan_json_file="${root_path}/pull-request.tfplan.json"

"${repository_root}/scripts/terraform-init-ci.sh" "${root}"
terraform -chdir="${root_path}" plan -input=false -lock=false -out="${plan_file}" >/dev/null
terraform -chdir="${root_path}" show -json "${plan_file}" >"${plan_json_file}"

if jq -e 'any(.resource_changes[]?; .change.actions | index("delete") != null)' "${plan_json_file}" >/dev/null; then
  printf 'error: %s contains a delete or replacement; pull request plan refused\n' "${root}" >&2
  exit 1
fi

create_count="$(jq '[.resource_changes[]? | select(.change.actions == ["create"])] | length' "${plan_json_file}")"
update_count="$(jq '[.resource_changes[]? | select(.change.actions == ["update"])] | length' "${plan_json_file}")"
read_count="$(jq '[.resource_changes[]? | select(.change.actions == ["read"])] | length' "${plan_json_file}")"

printf 'root=%s create=%s update=%s read=%s delete=0\n' "${root}" "${create_count}" "${update_count}" "${read_count}"
