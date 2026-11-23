#!/usr/bin/env bash
# Sourced by the CI Terraform scripts. The terraform-github and
# terraform-identity-admin roots trust this repository by its OIDC subject, whose form depends on the repository's
# settings (`repo:owner/name`, or with immutable ids `repo:owner@id/name@id`).
# In CI the job's own token states it exactly, so no owner or id is committed.

decide_github_subject() {
  local root="$1"
  [[ "${root}" == "infra/terraform-github" || "${root}" == "infra/terraform-identity-admin" ]] || return 0
  [[ -z "${TF_VAR_github_repository_subject:-}" ]] || return 0

  if [[ -z "${ACTIONS_ID_TOKEN_REQUEST_URL:-}" || -z "${ACTIONS_ID_TOKEN_REQUEST_TOKEN:-}" ]]; then
    printf 'error: set TF_VAR_github_repository_subject, for example repo:owner/spawnpoint\n' >&2
    return 1
  fi
  TF_VAR_github_repository_subject="$(
    curl -fsS -H "Authorization: bearer ${ACTIONS_ID_TOKEN_REQUEST_TOKEN}" \
      "${ACTIONS_ID_TOKEN_REQUEST_URL}&audience=sts.amazonaws.com" |
      python3 -I -c '
import base64, json, sys
payload = json.load(sys.stdin)["value"].split(".")[1]
subject = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))["sub"]
prefix = subject.split(":environment:", 1)[0]
if not prefix.startswith("repo:") or ":" in prefix[5:]:
    sys.exit(f"unexpected OIDC subject form: {subject}")
print(prefix)
'
  )" || return 1
  export TF_VAR_github_repository_subject
}
