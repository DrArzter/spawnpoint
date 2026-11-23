#!/usr/bin/env bash
# Prepares an AWS account and this GitHub repository for a first Spawnpoint
# deploy. Run it from a fork, signed in with `aws login` and `gh auth login`.
#
# It works out the account, region, repository, OIDC subject and every name;
# it asks only for the panel domain, an alert address and an optional
# CurseForge key. Each step checks what exists first, so a second run repairs
# a partial one and changes nothing else. Secrets are generated here, written
# to SSM Parameter Store and never printed or passed on a command line.
#
# Usage: scripts/onboard.sh [--dry-run] [--yes] [--allow-root]
#   --dry-run     read and report; change nothing
#   --yes         apply Terraform plans without asking
#   --allow-root  run as the account's root user (not recommended)
#
# Inputs, from the environment or a prompt:
#   SPAWNPOINT_DOMAIN       panel hostname whose zone moves to Route 53, such as play.example.com
#   SPAWNPOINT_ALERT_EMAIL  receives budget and anomaly alerts
#   SPAWNPOINT_CONFIG_SUBJECTS  optional JSON list of config repository OIDC subjects
#   SPAWNPOINT_OIDC_SUBJECT     optional; needed only when the repository customises its OIDC subject
#   AWS_PROFILE             profile to use; default `default`

set -Eeuo pipefail

readonly REGION="eu-central-1"
readonly TERRAFORM_MINIMUM="1.15.0"
repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
readonly repository_root

dry_run=false
assume_yes=false
allow_root=false
for argument in "$@"; do
  case "${argument}" in
    --dry-run) dry_run=true ;;
    --yes) assume_yes=true ;;
    --allow-root) allow_root=true ;;
    -h | --help)
      sed -n '2,22p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      printf 'error: unknown option %s\n' "${argument}" >&2
      exit 2
      ;;
  esac
done

export AWS_PROFILE="${AWS_PROFILE:-default}"
export AWS_REGION="${REGION}"
export TF_VAR_aws_profile="${AWS_PROFILE}"
export TF_VAR_aws_region="${REGION}"
export TF_IN_AUTOMATION=1

step() { printf '\n== %s\n' "$*"; }
note() { printf '   %s\n' "$*"; }
fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

# Every change goes through here, so --dry-run shows it and does nothing.
change() {
  if [[ "${dry_run}" == true ]]; then
    printf '   would run: %s\n' "$*"
    return 0
  fi
  "$@"
}

confirm() {
  [[ "${assume_yes}" == true ]] && return 0
  local answer
  read -r -p "   $1 [y/N] " answer || return 1
  [[ "${answer}" == y || "${answer}" == Y ]]
}

ask() {
  local name="$1" prompt="$2" value="${!1:-}"
  while [[ -z "${value}" ]]; do
    read -r -p "   ${prompt}: " value || fail "no value for ${name}"
  done
  printf -v "${name}" '%s' "${value}"
}

version_at_least() {
  python3 -I -c 'import sys; v = lambda s: tuple(int(p) for p in s.split("-")[0].split("."));
sys.exit(0 if v(sys.argv[1]) >= v(sys.argv[2]) else 1)' "$1" "$2"
}

# --- 1. What is here --------------------------------------------------------

preflight() {
  step "Checking tools and sign-ins"
  local tool
  for tool in aws gh terraform jq openssl python3 git; do
    command -v "${tool}" >/dev/null || fail "${tool} is not installed"
  done
  local terraform_version
  terraform_version="$(terraform version -json | jq -r .terraform_version)"
  version_at_least "${terraform_version}" "${TERRAFORM_MINIMUM}" ||
    fail "Terraform ${terraform_version} is older than ${TERRAFORM_MINIMUM}"

  local caller
  caller="$(aws sts get-caller-identity --output json)" ||
    fail "AWS profile ${AWS_PROFILE} is not signed in; run: aws login --profile ${AWS_PROFILE}"
  account_id="$(jq -r .Account <<<"${caller}")"
  local caller_arn
  caller_arn="$(jq -r .Arn <<<"${caller}")"
  if [[ "${caller_arn}" == *":root" && "${allow_root}" != true ]]; then
    fail "signed in as the account's root user; sign in as an administrator instead, or pass --allow-root"
  fi
  note "AWS account ${account_id} as ${caller_arn}, region ${REGION}"

  gh auth status >/dev/null 2>&1 || fail "GitHub CLI is not signed in; run: gh auth login"
  local repository_json
  repository_json="$(gh repo view --json nameWithOwner,visibility,viewerPermission)" ||
    fail "cannot tell which GitHub repository this is; run: gh repo set-default <you>/<fork>"
  repository="$(jq -r .nameWithOwner <<<"${repository_json}")"
  # A launched host clones the repository with no credential.
  [[ "$(jq -r .visibility <<<"${repository_json}")" == PUBLIC ]] ||
    fail "${repository} is not public; launched hosts clone it without a credential"
  [[ "$(jq -r .viewerPermission <<<"${repository_json}")" == ADMIN ]] ||
    fail "you are not an admin of ${repository}; fork it and run this in the fork"
  github_user_id="$(gh api user --jq .id)"
  note "GitHub repository ${repository}"

  state_bucket="spawnpoint-tfstate-${account_id}"
}

oidc_subject() {
  if [[ -n "${SPAWNPOINT_OIDC_SUBJECT:-}" ]]; then
    printf '%s' "${SPAWNPOINT_OIDC_SUBJECT}"
    return
  fi
  local uses_default
  uses_default="$(gh api "repos/${repository}/actions/oidc/customization/sub" --jq .use_default 2>/dev/null || printf 'true')"
  [[ "${uses_default}" == true ]] ||
    fail "${repository} customises its OIDC subject; set SPAWNPOINT_OIDC_SUBJECT to repo:<owner>/<name> in that form"
  printf 'repo:%s' "${repository}"
}

inputs() {
  step "Settings"
  ask SPAWNPOINT_DOMAIN "Panel domain (a subdomain you can delegate, such as play.example.com)"
  SPAWNPOINT_DOMAIN="$(tr '[:upper:]' '[:lower:]' <<<"${SPAWNPOINT_DOMAIN%.}")"
  [[ "${SPAWNPOINT_DOMAIN}" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ ]] ||
    fail "${SPAWNPOINT_DOMAIN} is not a domain name"
  ask SPAWNPOINT_ALERT_EMAIL "Address for budget and cost alerts"
  [[ "${SPAWNPOINT_ALERT_EMAIL}" =~ ^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$ ]] ||
    fail "${SPAWNPOINT_ALERT_EMAIL} is not an email address"
  config_subjects="${SPAWNPOINT_CONFIG_SUBJECTS:-[]}"
  jq -e 'type == "array" and all(type == "string")' <<<"${config_subjects}" >/dev/null ||
    fail "SPAWNPOINT_CONFIG_SUBJECTS must be a JSON list of strings"
  repository_subject="$(oidc_subject)"
  note "domain ${SPAWNPOINT_DOMAIN}; OIDC subject ${repository_subject}"
}

# --- 2. State bucket ----------------------------------------------------------

bootstrap_state() {
  step "Terraform state bucket"
  if aws s3api head-bucket --bucket "${state_bucket}" >/dev/null 2>&1; then
    note "${state_bucket} exists"
  elif [[ "${dry_run}" == true ]]; then
    note "would create ${state_bucket} with infra/terraform-bootstrap"
  else
    local root="${repository_root}/infra/terraform-bootstrap"
    terraform -chdir="${root}" init -input=false >/dev/null
    apply_plan "${root}" "the state bucket ${state_bucket}"
    note "keep a private copy of ${root}/terraform.tfstate"
  fi
  change "${repository_root}/scripts/write-backend-config.sh"
}

# --- 3. Secrets ---------------------------------------------------------------

# Writes a SecureString once. The value reaches the CLI through a 0600 file,
# never argv, and an existing parameter is never overwritten.
put_secret_once() {
  local name="$1" value="$2"
  if aws ssm get-parameter --name "${name}" --query Parameter.Name --output text >/dev/null 2>&1; then
    note "${name} exists"
    return
  fi
  if [[ "${dry_run}" == true ]]; then
    note "would write ${name}"
    return
  fi
  local file
  file="$(umask 077 && mktemp)"
  printf '%s' "${value}" >"${file}"
  aws ssm put-parameter --name "${name}" --type SecureString --value "file://${file}" --no-overwrite >/dev/null ||
    {
      rm -f "${file}"
      fail "could not write ${name}"
    }
  rm -f "${file}"
  note "wrote ${name}"
}

random_secret() { openssl rand -base64 48 | tr -d '\n/+=' | cut -c1-48; }

secrets() {
  step "Secrets in Parameter Store"
  put_secret_once /spawnpoint/auth/session-signing-secret "$(random_secret)"
  put_secret_once /spawnpoint/host/env/RCON_PASSWORD "$(random_secret)"
  put_secret_once /spawnpoint/host/env/GRAFANA_ADMIN_PASSWORD "$(random_secret)"
  put_secret_once /spawnpoint/host/env/BACKUP_BUCKET "spawnpoint-backups-${account_id}"
  put_secret_once /spawnpoint/host/env/RELEASE_BUCKET "spawnpoint-releases-${account_id}"
  put_secret_once /spawnpoint/host/env/AWS_REGION "${REGION}"

  if aws ssm get-parameter --name /spawnpoint/host/env/CF_API_KEY --query Parameter.Name --output text >/dev/null 2>&1; then
    note "/spawnpoint/host/env/CF_API_KEY exists"
    return
  fi
  local curseforge_key=""
  if [[ "${dry_run}" != true ]]; then
    read -r -s -p "   CurseForge API key for modpacks (Enter to skip): " curseforge_key || true
    printf '\n'
  fi
  if [[ -z "${curseforge_key}" ]]; then
    # Launch readiness needs the parameter; CurseForge modpacks fail until it is replaced.
    curseforge_key="not-configured"
    note "no CurseForge key: modpacks from CurseForge will not build until you set one"
  fi
  put_secret_once /spawnpoint/host/env/CF_API_KEY "${curseforge_key}"
  put_secret_once /spawnpoint/releases/curseforge-api-key "${curseforge_key}"
}

# --- 4. Identities and the zone, applied from here once ------------------------

apply_plan() {
  local root="$1" what="$2" plan_file="${1}/onboard.tfplan"
  terraform -chdir="${root}" plan -input=false -out="${plan_file}" >/dev/null
  local plan_json summary
  plan_json="$(terraform -chdir="${root}" show -json "${plan_file}")"
  summary="$(jq -r '[.resource_changes[]?.change.actions | select(. != ["no-op"]) | join("/")]
    | group_by(.) | map("\(length) \(.[0])") | join(", ")' <<<"${plan_json}")"
  if [[ -z "${summary}" ]]; then
    note "${what}: no changes"
    rm -f "${plan_file}"
    return
  fi
  note "${what}: ${summary}"
  if jq -e '[.resource_changes[]? | select(.change.actions | index("delete"))] | length > 0' <<<"${plan_json}" >/dev/null; then
    rm -f "${plan_file}"
    fail "${what}: the plan deletes something; onboarding never deletes. Inspect it with terraform plan"
  fi
  if [[ "${dry_run}" == true ]]; then
    rm -f "${plan_file}"
    return
  fi
  confirm "Apply ${what}?" || fail "stopped before ${what}"
  terraform -chdir="${root}" apply -input=false "${plan_file}"
  rm -f "${plan_file}"
}

init_root() {
  local root="$1"
  [[ -f "${root}/backend.hcl" ]] || fail "${root}/backend.hcl is missing; run scripts/write-backend-config.sh"
  terraform -chdir="${root}" init -input=false -reconfigure -backend-config=backend.hcl >/dev/null
}

local_roots() {
  step "GitHub identities and the DNS zone"
  if [[ "${dry_run}" == true && ! -f "${repository_root}/infra/terraform-github/backend.hcl" ]]; then
    note "would plan terraform-github, terraform-identity-admin and terraform-domain once the state bucket exists"
    return
  fi
  export TF_VAR_github_repository_subject="${repository_subject}"
  export TF_VAR_github_subjects="${config_subjects}"
  export TF_VAR_domain_name="${SPAWNPOINT_DOMAIN}"

  # The OIDC provider lives in terraform-github, and identity-admin trusts it.
  local root
  for root in terraform-github terraform-identity-admin terraform-domain; do
    init_root "${repository_root}/infra/${root}"
    apply_plan "${repository_root}/infra/${root}" "${root}"
  done
}

output_of() {
  local value
  value="$(terraform -chdir="${repository_root}/infra/$1" output -raw "$2" 2>/dev/null || true)"
  [[ -n "${value}" || "${dry_run}" == true ]] || fail "infra/$1 has no output $2"
  printf '%s' "${value}"
}

# --- 5. GitHub ------------------------------------------------------------------

set_variable() {
  local name="$1" value="$2"
  if [[ -n "${3:-}" ]]; then
    change gh variable set "${name}" --repo "${repository}" --env "$3" --body "${value}" >/dev/null
  else
    change gh variable set "${name}" --repo "${repository}" --body "${value}" >/dev/null
  fi
}

set_secret() {
  local name="$1" value="$2" environment="$3"
  if [[ "${dry_run}" == true ]]; then
    note "would set secret ${name} in ${environment}"
    return
  fi
  printf '%s' "${value}" | gh secret set "${name}" --repo "${repository}" --env "${environment}" >/dev/null
}

environment() {
  local name="$1" reviewed="$2" body='{}'
  [[ "${reviewed}" == true ]] &&
    body="$(jq -nc --argjson id "${github_user_id}" '{reviewers: [{type: "User", id: $id}], prevent_self_review: false}')"
  if [[ "${dry_run}" == true ]]; then
    note "would create environment ${name}$([[ "${reviewed}" == true ]] && printf ' (you approve it)')"
    return
  fi
  gh api --method PUT "repos/${repository}/environments/${name}" --input - <<<"${body}" >/dev/null
}

github() {
  step "GitHub settings for ${repository}"
  # Forks start with Actions off.
  change gh api --method PUT "repos/${repository}/actions/permissions" -F enabled=true -f allowed_actions=all

  environment production false
  environment production-plan true
  environment production-identity true

  set_variable AWS_DEPLOY_ROLE_ARN "$(output_of terraform-github github_deploy_role_arn)" production
  set_variable AWS_PLAN_ROLE_ARN "$(output_of terraform-github github_plan_role_arn)" production-plan
  set_variable AWS_IDENTITY_ROLE_ARN "$(output_of terraform-identity-admin github_identity_admin_role_arn)" production-identity
  set_secret TF_VAR_ALERT_EMAIL "${SPAWNPOINT_ALERT_EMAIL}" production
  set_secret TF_VAR_ALERT_EMAIL "${SPAWNPOINT_ALERT_EMAIL}" production-plan

  set_variable AWS_REGION "${REGION}"
  set_variable TF_STATE_BUCKET "${state_bucket}"
  set_variable SESSION_SIGNING_SECRET_PARAMETER /spawnpoint/auth/session-signing-secret
  set_variable SPAWNPOINT_DOMAIN "${SPAWNPOINT_DOMAIN}"
  set_variable SPAWNPOINT_API_DOMAIN "api.${SPAWNPOINT_DOMAIN}"
  set_variable SPAWNPOINT_MINI_APP_URL "https://${SPAWNPOINT_DOMAIN}/"
  set_variable SPAWNPOINT_GAME_DNS_ZONE "${SPAWNPOINT_DOMAIN}"
  set_variable SPAWNPOINT_GAME_DNS_SUFFIX "${SPAWNPOINT_DOMAIN}"
  # A new account has no configured host: every world runs on a launched one.
  set_variable SPAWNPOINT_PLACEMENT fleet
  set_variable SPAWNPOINT_LAUNCH enabled
  set_variable CONFIG_REPOSITORY_SUBJECTS "${config_subjects}"
  note "Actions on; environments production, production-plan and production-identity; roles, alert address and variables set"
}

# --- 6. What is left for a person -----------------------------------------------

delegation() {
  step "DNS delegation"
  local servers
  servers="$(terraform -chdir="${repository_root}/infra/terraform-domain" output -json name_servers 2>/dev/null | jq -r '.[]' || true)"
  if [[ -z "${servers}" ]]; then
    note "the zone for ${SPAWNPOINT_DOMAIN} is created on a run without --dry-run"
    return
  fi
  note "At the DNS provider of the parent domain, add NS records for ${SPAWNPOINT_DOMAIN}:"
  local server
  while IFS= read -r server; do
    note "  ${server}"
  done <<<"${servers}"
  note "The panel certificate is issued only after these records resolve."
}

main() {
  [[ "${dry_run}" == true ]] && printf 'Dry run: nothing is changed.\n'
  preflight
  inputs
  bootstrap_state
  secrets
  local_roots
  github
  delegation
  step "Next"
  note "Confirm the AWS email to ${SPAWNPOINT_ALERT_EMAIL} so alerts arrive."
  note "Run the Deploy production workflow on main in ${repository}."
}

main
