#!/usr/bin/env bash

set -Eeuo pipefail

root="${1:?usage: terraform-apply-safe.sh <terraform-root>}"
repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
root_path="${repository_root}/${root}"
plan_file="${root_path}/production.tfplan"
plan_json_file="${root_path}/production.tfplan.json"

# shellcheck source=_terraform-destroy-allow.sh
source "${repository_root}/scripts/_terraform-destroy-allow.sh"

"${repository_root}/scripts/terraform-init-ci.sh" "${root}"
terraform -chdir="${root_path}" plan -input=false -out="${plan_file}"
terraform -chdir="${root_path}" show -json "${plan_file}" >"${plan_json_file}"

if jq -e '[.resource_changes[]? | select(.change.actions != ["no-op"])] | length == 0' "${plan_json_file}" >/dev/null; then
  printf 'result=unchanged\nroot=%s\n' "${root}"
  exit 0
fi

# The judgement the pull request saw, made again against the live state at
# apply time: a delete or replacement runs only if the root's
# destroy-allowed.txt names its exact address.
if ! assess_destroys "${root_path}" "${plan_json_file}"; then
  report_destroys "${root}" >&2
  printf 'error: %s contains a delete or replacement that is not allow-listed; automatic apply refused\n' "${root}" >&2
  terraform -chdir="${root_path}" show -no-color "${plan_file}" >&2
  exit 1
fi
report_destroys "${root}" >&2

terraform -chdir="${root_path}" apply -input=false -auto-approve "${plan_file}"
printf 'result=deployed\nroot=%s\ndestroyed=%s\nstale=%s\n' "${root}" "${DESTROY_ALLOWED}" "${ALLOW_STALE}"
