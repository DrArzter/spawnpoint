#!/usr/bin/env bash

set -Eeuo pipefail

root="${1:?usage: terraform-plan-safe.sh <terraform-root>}"
repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
root_path="${repository_root}/${root}"
plan_file="${root_path}/pull-request.tfplan"
plan_json_file="${root_path}/pull-request.tfplan.json"

# shellcheck source=_terraform-destroy-allow.sh
source "${repository_root}/scripts/_terraform-destroy-allow.sh"

"${repository_root}/scripts/terraform-init-ci.sh" "${root}" >/dev/null
if ! terraform -chdir="${root_path}" plan -input=false -lock=false -out="${plan_file}" >/dev/null; then
  printf 'root=%s add=0 change=0 delete=0 read=0 allowed=0 stale=0 result=error\n' "${root}"
  exit 1
fi
if ! terraform -chdir="${root_path}" show -json "${plan_file}" >"${plan_json_file}"; then
  printf 'root=%s add=0 change=0 delete=0 read=0 allowed=0 stale=0 result=error\n' "${root}"
  exit 1
fi

count_actions() {
  jq --arg action "$1" '[.resource_changes[]? | select(.change.actions | index($action) != null)] | length' "${plan_json_file}"
}
create_count="$(count_actions create)"
update_count="$(count_actions update)"
delete_count="$(count_actions delete)"
read_count="$(count_actions read)"

# A delete or replacement fails the check unless the root's destroy-allowed.txt
# names its exact address; the library holds the rule and the types it covers.
if ! assess_destroys "${root_path}" "${plan_json_file}"; then
  printf 'root=%s add=%s change=%s delete=%s read=%s allowed=%s stale=%s result=destructive\n' \
    "${root}" "${create_count}" "${update_count}" "${delete_count}" "${read_count}" "${DESTROY_ALLOWED}" "${ALLOW_STALE}"
  report_destroys "${root}" >&2
  printf 'error: %s contains a delete or replacement that is not allow-listed; pull request plan refused\n' "${root}" >&2
  exit 1
fi

report_destroys "${root}" >&2
printf 'root=%s add=%s change=%s delete=%s read=%s allowed=%s stale=%s result=ok\n' \
  "${root}" "${create_count}" "${update_count}" "${delete_count}" "${read_count}" "${DESTROY_ALLOWED}" "${ALLOW_STALE}"
