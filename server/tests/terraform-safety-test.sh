#!/usr/bin/env bash

# The pipeline's one opening for a Terraform delete is an exact address in the
# root's destroy-allowed.txt, reviewed in the diff. Both safe scripts run here
# against a stand-in terraform that returns a canned plan, so every branch of
# the judgement is exercised without a backend, a provider or credentials.

set -Eeuo pipefail

repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
fixture="$(mktemp -d /tmp/spawnpoint-terraform-safety.XXXXXXXX)"
cleanup() {
  rm -rf -- "${fixture}"
}
trap cleanup EXIT

expect_failure() {
  local label="$1"
  shift
  if "$@" >"${fixture}/out" 2>"${fixture}/err"; then
    printf 'expected failure: %s\n' "${label}" >&2
    exit 1
  fi
}

# The scripts resolve the repository from their own location, so a copy of
# scripts/ beside a fixture root stands in for the whole tree.
mkdir -p -- "${fixture}/bin" "${fixture}/infra/test-root"
cp -R -- "${repository_root}/scripts" "${fixture}/scripts"
printf 'key = "spawnpoint/test-root.tfstate"\n' >"${fixture}/infra/test-root/backend.hcl.example"
cat >"${fixture}/bin/terraform" <<'STUB'
#!/usr/bin/env bash
# init and plan succeed, show -json prints the canned plan, apply leaves a mark.
set -Eeuo pipefail
args=("$@")
[[ "${args[0]}" == -chdir=* ]] && args=("${args[@]:1}")
case "${args[0]}" in
  init) exit 0 ;;
  plan)
    for argument in "${args[@]}"; do
      [[ "${argument}" == -out=* ]] && : >"${argument#-out=}"
    done
    exit 0 ;;
  show)
    if [[ " ${args[*]} " == *" -json "* ]]; then cat "${FAKE_TERRAFORM_PLAN_JSON:?}"; else printf 'fake plan\n'; fi
    exit 0 ;;
  apply) printf 'applied\n' >>"${FAKE_TERRAFORM_APPLIED:?}"; exit 0 ;;
  *) exit 64 ;;
esac
STUB
chmod +x "${fixture}/bin/terraform"
export PATH="${fixture}/bin:${PATH}" TF_STATE_BUCKET=spawnpoint-tfstate-test
export FAKE_TERRAFORM_PLAN_JSON="${fixture}/plan.json" FAKE_TERRAFORM_APPLIED="${fixture}/applied"

plan_safe="${fixture}/scripts/terraform-plan-safe.sh"
apply_safe="${fixture}/scripts/terraform-apply-safe.sh"
root=infra/test-root
allow="${fixture}/infra/test-root/destroy-allowed.txt"
route='aws_apigatewayv2_route.access["POST /games/{gameId}/worlds/{worldId}/regenerate"]'

change() {
  jq -cn --arg address "$1" --arg type "$2" --argjson actions "$3" '{address: $address, type: $type, change: {actions: $actions}}'
}
plan_with() {
  local IFS=,
  printf '{"resource_changes":[%s]}\n' "$*" >"${FAKE_TERRAFORM_PLAN_JSON}"
}

# --- creates and updates pass, and the summary line carries the new fields ---
plan_with "$(change aws_iam_role.bot aws_iam_role '["update"]')" "$(change aws_lambda_function.bot aws_lambda_function '["create"]')"
grep -Fxq "root=${root} add=1 change=1 delete=0 read=0 allowed=0 stale=0 result=ok" <<<"$("${plan_safe}" "${root}" 2>/dev/null)"

# --- a delete with no allow-list is refused, and the refusal names the address and the file ---
plan_with "$(change "${route}" aws_apigatewayv2_route '["delete"]')"
expect_failure "unlisted delete" "${plan_safe}" "${root}"
grep -Fq 'result=destructive' "${fixture}/out"
grep -Fq "${route}" "${fixture}/err"
grep -Fq 'destroy-allowed.txt' "${fixture}/err"

# --- the same delete, listed: comments, blank lines and whitespace are ignored ---
printf '# the alias of the wipe route, ADR-0040\n\n   %s   # trailing comment\n' "${route}" >"${allow}"
grep -Fxq "root=${root} add=0 change=0 delete=1 read=0 allowed=1 stale=0 result=ok" <<<"$("${plan_safe}" "${root}" 2>"${fixture}/err")"
grep -Fq 'allow-listed' "${fixture}/err"

# --- a replacement is a destroy too: listed passes, an unlisted one beside it refuses the plan ---
plan_with "$(change "${route}" aws_apigatewayv2_route '["delete","create"]')" "$(change aws_iam_role.other aws_iam_role '["delete","create"]')"
expect_failure "unlisted replacement" "${plan_safe}" "${root}"
grep -Fq 'delete=2' "${fixture}/out"
grep -Fq 'allowed=1' "${fixture}/out"
grep -Fq 'aws_iam_role.other' "${fixture}/err"

# --- a type the pipeline may never destroy cannot be listed, even when the plan does not touch it ---
printf '%s\n' aws_ebs_volume.data >"${allow}"
plan_with "$(change aws_iam_role.bot aws_iam_role '["update"]')"
expect_failure "protected type listed" "${plan_safe}" "${root}"
grep -Fq 'can never be destroyed by the pipeline' "${fixture}/err"
printf 'module.host.aws_instance.game\n' >"${allow}"
expect_failure "protected type behind a module prefix" "${plan_safe}" "${root}"
printf '%s\n' aws_ebs_volume.data >"${allow}"
plan_with "$(change aws_ebs_volume.data aws_ebs_volume '["delete"]')"
expect_failure "protected type destroyed" "${plan_safe}" "${root}"

# --- a stale entry is a warning, not a refusal ---
printf '%s\n' "${route}" >"${allow}"
plan_with "$(change aws_iam_role.bot aws_iam_role '["update"]')"
grep -Fxq "root=${root} add=0 change=1 delete=0 read=0 allowed=0 stale=1 result=ok" <<<"$("${plan_safe}" "${root}" 2>"${fixture}/err")"
grep -Fq 'stale entry' "${fixture}/err"

# --- the apply makes the same judgement: refused means nothing was applied ---
rm -f -- "${allow}"
plan_with "$(change "${route}" aws_apigatewayv2_route '["delete"]')"
expect_failure "apply of an unlisted delete" "${apply_safe}" "${root}"
[[ ! -e "${FAKE_TERRAFORM_APPLIED}" ]]
grep -Fq 'automatic apply refused' "${fixture}/err"

printf '%s\n' "${route}" >"${allow}"
apply_output="$("${apply_safe}" "${root}" 2>/dev/null)"
[[ -e "${FAKE_TERRAFORM_APPLIED}" ]]
grep -Fxq 'result=deployed' <<<"${apply_output}"
grep -Fxq 'destroyed=1' <<<"${apply_output}"

plan_with "$(change aws_iam_role.bot aws_iam_role '["no-op"]')"
grep -Fxq 'result=unchanged' <<<"$("${apply_safe}" "${root}" 2>/dev/null)"

printf 'terraform-safety-test: ok\n'
