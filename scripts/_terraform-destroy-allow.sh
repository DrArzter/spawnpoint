#!/usr/bin/env bash
# shellcheck disable=SC2034  # the DESTROY_* and ALLOW_* variables are this library's interface, read by its sourcers

# The production pipeline refuses every Terraform delete and replacement. This
# is its one deliberate opening: a root may name exact resource addresses in
# destroy-allowed.txt, one per line, and only those may be destroyed. The line
# travels in the pull request, so a destroy is something a reviewer reads in the
# diff — never a label, never a bypass of the branch protection.
#
# Only the types below may be listed. They are control-plane wiring that
# Terraform recreates from the repository alone, and the deploy identity in
# infra/terraform-github holds exactly the delete actions they need. Every other
# type — the host, its volume, the buckets, the tables, the OIDC trust, the
# CloudFront distribution, the bot's Function URL, the guardrails — stays
# undeletable at IAM as well, so a mistake in a list cannot reach them. The two
# lists are kept in step by scripts/tests/deployment_security_test.py.

set -Eeuo pipefail

DESTROY_DELETABLE_TYPES=(
  aws_apigatewayv2_integration
  aws_apigatewayv2_route
  aws_cloudwatch_event_rule
  aws_cloudwatch_event_target
  aws_cloudwatch_log_group
  aws_cloudwatch_metric_alarm
  aws_codebuild_project
  aws_iam_role
  aws_iam_role_policy
  aws_iam_role_policy_attachment
  aws_lambda_permission
  aws_sfn_state_machine
  aws_sns_topic_subscription
)

# One address per line. A '#' at the start of a line or after whitespace begins
# a comment; surrounding whitespace is ignored.
read_destroy_allow_list() {
  local file="$1/destroy-allowed.txt"
  [[ -f "${file}" ]] || return 0
  sed -E -e 's/(^|[[:space:]])#.*$//' -e 's/^[[:space:]]+//' -e 's/[[:space:]]+$//' "${file}" | awk 'NF'
}

# The resource type of an address: module prefixes stripped, then the first segment.
destroy_address_type() {
  local address="$1"
  while [[ "${address}" == module.* ]]; do
    address="${address#module.}"
    address="${address#*.}"
  done
  printf '%s\n' "${address%%.*}"
}

destroy_type_is_deletable() {
  local candidate
  for candidate in "${DESTROY_DELETABLE_TYPES[@]}"; do
    [[ "${candidate}" == "$1" ]] && return 0
  done
  return 1
}

destroy_list_contains() {
  local needle="$1" candidate
  shift
  for candidate in "$@"; do
    [[ "${candidate}" == "${needle}" ]] && return 0
  done
  return 1
}

# assess_destroys <root_path> <plan_json_file>
# Reads every delete or replacement in the plan against the root's allow-list.
# Sets DESTROY_TOTAL, DESTROY_ALLOWED, DESTROY_REFUSED, ALLOW_STALE, ALLOW_INVALID
# and the matching *_ADDRESSES arrays. Returns 0 when nothing is refused and
# every listed entry names a type the pipeline may destroy.
assess_destroys() {
  local root_path="$1" plan_json="$2" address type entry
  DESTROY_TOTAL=0 DESTROY_ALLOWED=0 DESTROY_REFUSED=0 ALLOW_STALE=0 ALLOW_INVALID=0
  DESTROY_ALLOWED_ADDRESSES=() DESTROY_REFUSED_ADDRESSES=() ALLOW_STALE_ADDRESSES=() ALLOW_INVALID_ADDRESSES=()
  local -a listed=() destroyed=()
  mapfile -t listed < <(read_destroy_allow_list "${root_path}")

  # A listed address of a type the pipeline may never destroy is a mistake in
  # the file itself, refused whether or not this plan touches it.
  for entry in "${listed[@]}"; do
    destroy_type_is_deletable "$(destroy_address_type "${entry}")" || {
      ALLOW_INVALID=$((ALLOW_INVALID + 1))
      ALLOW_INVALID_ADDRESSES+=("${entry}")
    }
  done

  while IFS=$'\t' read -r address type; do
    [[ -n "${address}" ]] || continue
    DESTROY_TOTAL=$((DESTROY_TOTAL + 1))
    destroyed+=("${address}")
    if destroy_type_is_deletable "${type}" && destroy_list_contains "${address}" "${listed[@]}"; then
      DESTROY_ALLOWED=$((DESTROY_ALLOWED + 1))
      DESTROY_ALLOWED_ADDRESSES+=("${address}")
    else
      DESTROY_REFUSED=$((DESTROY_REFUSED + 1))
      DESTROY_REFUSED_ADDRESSES+=("${address}")
    fi
  done < <(jq -r '.resource_changes[]? | select(.change.actions | index("delete") != null) | [.address, .type] | @tsv' "${plan_json}")

  for entry in "${listed[@]}"; do
    destroy_list_contains "${entry}" "${ALLOW_INVALID_ADDRESSES[@]}" && continue
    destroy_list_contains "${entry}" "${destroyed[@]}" || {
      ALLOW_STALE=$((ALLOW_STALE + 1))
      ALLOW_STALE_ADDRESSES+=("${entry}")
    }
  done
  (( DESTROY_REFUSED == 0 && ALLOW_INVALID == 0 ))
}

# report_destroys <root>: the human account of the last assessment, for stderr.
report_destroys() {
  local root="$1" address
  for address in "${ALLOW_INVALID_ADDRESSES[@]}"; do
    printf 'error: %s is listed in %s/destroy-allowed.txt, but its type can never be destroyed by the pipeline\n' "${address}" "${root}"
  done
  for address in "${DESTROY_REFUSED_ADDRESSES[@]}"; do
    printf 'error: the plan destroys %s, which is not allow-listed\n' "${address}"
  done
  if (( DESTROY_REFUSED > 0 )); then
    printf 'hint: name the exact address in %s/destroy-allowed.txt in the same pull request; a type the pipeline may not destroy is an owner apply\n' "${root}"
  fi
  for address in "${DESTROY_ALLOWED_ADDRESSES[@]}"; do
    printf 'note: the plan destroys %s, allow-listed\n' "${address}"
  done
  for address in "${ALLOW_STALE_ADDRESSES[@]}"; do
    printf 'warning: %s is allow-listed but this plan does not destroy it; remove the stale entry\n' "${address}"
  done
}
