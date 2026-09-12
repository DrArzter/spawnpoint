#!/usr/bin/env bash

set -Eeuo pipefail

root="${1:?usage: terraform-plan-safe.sh <terraform-root>}"
repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
root_path="${repository_root}/${root}"
plan_file="${root_path}/pull-request.tfplan"
plan_json_file="${root_path}/pull-request.tfplan.json"

"${repository_root}/scripts/terraform-init-ci.sh" "${root}" >/dev/null
if ! terraform -chdir="${root_path}" plan -input=false -lock=false -out="${plan_file}" >/dev/null; then
  printf 'root=%s add=0 change=0 delete=0 read=0 result=error\n' "${root}"
  exit 1
fi
if ! terraform -chdir="${root_path}" show -json "${plan_file}" >"${plan_json_file}"; then
  printf 'root=%s add=0 change=0 delete=0 read=0 result=error\n' "${root}"
  exit 1
fi

create_count="$(jq '[.resource_changes[]? | select(.change.actions | index("create") != null)] | length' "${plan_json_file}")"
update_count="$(jq '[.resource_changes[]? | select(.change.actions | index("update") != null)] | length' "${plan_json_file}")"
delete_count="$(jq '[.resource_changes[]? | select(.change.actions | index("delete") != null)] | length' "${plan_json_file}")"
read_count="$(jq '[.resource_changes[]? | select(.change.actions | index("read") != null)] | length' "${plan_json_file}")"

if (( delete_count > 0 )); then
  printf 'root=%s add=%s change=%s delete=%s read=%s result=destructive\n' \
    "${root}" "${create_count}" "${update_count}" "${delete_count}" "${read_count}"
  printf 'error: %s contains a delete or replacement; pull request plan refused\n' "${root}" >&2
  exit 1
fi

printf 'root=%s add=%s change=%s delete=0 read=%s result=ok\n' "${root}" "${create_count}" "${update_count}" "${read_count}"
