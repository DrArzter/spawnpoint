#!/usr/bin/env bash

set -Eeuo pipefail

root="${1:?usage: terraform-verify-applied.sh <terraform-root>}"
repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
root_path="${repository_root}/${root}"
plan_file="${root_path}/manual-verification.tfplan"
plan_json_file="${root_path}/manual-verification.tfplan.json"

"${repository_root}/scripts/terraform-init-ci.sh" "${root}" >/dev/null
if ! terraform -chdir="${root_path}" plan -input=false -lock=false -out="${plan_file}" >/dev/null; then
  printf 'root=%s changes=unknown result=error\n' "${root}"
  exit 1
fi
if ! terraform -chdir="${root_path}" show -json "${plan_file}" >"${plan_json_file}"; then
  printf 'root=%s changes=unknown result=error\n' "${root}"
  exit 1
fi

change_count="$(jq '[.resource_changes[]? | select(.change.actions != ["no-op"])] | length' "${plan_json_file}")"
if (( change_count > 0 )); then
  printf 'root=%s changes=%s result=pending-manual-apply\n' "${root}" "${change_count}"
  exit 1
fi

printf 'root=%s changes=0 result=applied\n' "${root}"
