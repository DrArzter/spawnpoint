#!/usr/bin/env bash

# Bring this host's checkout to the commit production deployed (ADR-0067),
# before a session starts on it. The commit is read from Parameter Store, where
# the access API root writes it on every apply. The checkout moves only while
# no game runs on the host: a running session keeps the scripts and Compose
# files it was started with. Nothing here may stop a start: on any refusal the
# start runs the checkout the host has, and the output says why.
#
# Prints key=value lines: result=updated|current|kept, and for kept a reason.
# Exits 0 in every case.

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd -- "${SCRIPT_DIR}/../.." && pwd)"
PARAMETER="${SPAWNPOINT_APP_COMMIT_PARAMETER:-/spawnpoint/host/app-commit}"

# Root runs this through SSM; the checkout may belong to another user.
git_app() {
  git -c safe.directory="${APP_DIR}" -C "${APP_DIR}" "$@"
}

kept() {
  printf 'result=kept\nreason=%s\n' "$1"
  [[ -z "${2:-}" ]] || printf 'commit=%s\n' "$2"
  exit 0
}

host_region() {
  if [[ -n "${AWS_REGION:-}" ]]; then
    printf '%s' "${AWS_REGION}"
    return 0
  fi
  local token
  token="$(curl -fsS --max-time 2 -X PUT -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' \
    http://169.254.169.254/latest/api/token)" || return 1
  curl -fsS --max-time 2 -H "X-aws-ec2-metadata-token: ${token}" \
    http://169.254.169.254/latest/meta-data/placement/region
}

git_app rev-parse --git-dir >/dev/null 2>&1 || kept not_a_checkout
current="$(git_app rev-parse HEAD)"

region="$(host_region)" || kept region_unavailable "${current}"
wanted="$(aws ssm get-parameter --region "${region}" --name "${PARAMETER}" \
  --query Parameter.Value --output text 2>/dev/null)" || kept parameter_unreadable "${current}"
# A commit or a ref name, never anything git could read as an option.
[[ "${wanted}" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]{0,119}$ ]] || kept parameter_invalid "${current}"

if [[ "${wanted}" == "${current}" ]]; then
  printf 'result=current\ncommit=%s\n' "${current}"
  exit 0
fi

activity="$("${SCRIPT_DIR}/check-host-activity.sh" 2>/dev/null)" || kept activity_unavailable "${current}"
grep -Fxq 'host=idle' <<<"${activity}" || kept sessions_running "${current}"
[[ -z "$(git_app status --porcelain --untracked-files=no)" ]] || kept local_changes "${current}"

git_app fetch -q --depth 1 origin "${wanted}" 2>/dev/null || kept fetch_failed "${current}"
git_app checkout -q --detach FETCH_HEAD 2>/dev/null || kept checkout_failed "${current}"
updated="$(git_app rev-parse HEAD)"
if [[ "${updated}" == "${current}" ]]; then
  printf 'result=current\ncommit=%s\n' "${updated}"
else
  printf 'result=updated\nfrom=%s\ncommit=%s\n' "${current}" "${updated}"
fi
