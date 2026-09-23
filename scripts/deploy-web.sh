#!/usr/bin/env bash

set -Eeuo pipefail

REPOSITORY_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
TERRAFORM_BIN="${TERRAFORM_BIN:-terraform}"
AWS_PROFILE_NAME="${AWS_PROFILE_NAME-${AWS_PROFILE:-}}"
AWS_REGION="${AWS_REGION:?set AWS_REGION in the environment}"
WEB_ROOT="${REPOSITORY_ROOT}/web"
TERRAFORM_ROOT="${REPOSITORY_ROOT}/infra/terraform-web"
ACCESS_TERRAFORM_ROOT="${REPOSITORY_ROOT}/infra/terraform-access-api"

terraform_output_if_available() {
  local name="$1"
  "${TERRAFORM_BIN}" -chdir="${ACCESS_TERRAFORM_ROOT}" output -raw "${name}" 2>/dev/null || true
}

if [[ -z "${VITE_ACCESS_API_URL:-}" ]]; then
  VITE_ACCESS_API_URL="$(terraform_output_if_available api_url)"
fi
if [[ -z "${VITE_TELEGRAM_OIDC_CLIENT_ID:-}" ]]; then
  VITE_TELEGRAM_OIDC_CLIENT_ID="$(terraform_output_if_available telegram_oidc_client_id)"
fi
if [[ -z "${VITE_GOOGLE_OIDC_CLIENT_ID:-}" ]]; then
  VITE_GOOGLE_OIDC_CLIENT_ID="$(terraform_output_if_available google_oidc_client_id)"
fi
export VITE_ACCESS_API_URL VITE_TELEGRAM_OIDC_CLIENT_ID VITE_GOOGLE_OIDC_CLIENT_ID

aws_profile_args=()
if [[ -n "${AWS_PROFILE_NAME}" ]]; then
  aws_profile_args=(--profile "${AWS_PROFILE_NAME}")
fi

# The API is the one thing a panel cannot do without. Every browser provider is
# optional and switched on by its own client id; a build without one simply
# draws no button for it.
if [[ -z "${VITE_ACCESS_API_URL}" ]]; then
  printf 'error: access API is not applied; refusing to publish a panel without authentication\n' >&2
  exit 1
fi
if [[ -z "${VITE_TELEGRAM_OIDC_CLIENT_ID}" && -z "${VITE_GOOGLE_OIDC_CLIENT_ID}" ]]; then
  printf 'note: no Telegram or Google client id; the panel will offer only what the API lists\n' >&2
fi

cd -- "${WEB_ROOT}"
npm run build

bucket_name="${WEB_BUCKET_NAME:-}"
mini_app_url="${MINI_APP_URL:-}"

if [[ -z "${bucket_name}" || -z "${mini_app_url}" ]]; then
  command -v "${TERRAFORM_BIN}" >/dev/null 2>&1 || {
    printf 'error: terraform is unavailable; set WEB_BUCKET_NAME and MINI_APP_URL explicitly\n' >&2
    exit 1
  }
  [[ -n "${bucket_name}" ]] || bucket_name="$(${TERRAFORM_BIN} -chdir="${TERRAFORM_ROOT}" output -raw bucket_name)"
  [[ -n "${mini_app_url}" ]] || mini_app_url="$(${TERRAFORM_BIN} -chdir="${TERRAFORM_ROOT}" output -raw mini_app_url)"
fi

if aws s3 cp "s3://${bucket_name}/index.html" - \
  --region "${AWS_REGION}" "${aws_profile_args[@]}" 2>/dev/null |
  cmp -s - "${WEB_ROOT}/dist/index.html"; then
  printf 'result=unchanged\nurl=%s\n' "${mini_app_url}"
  exit 0
fi

aws s3 sync "${WEB_ROOT}/dist/assets" "s3://${bucket_name}/assets" \
  --delete \
  --cache-control 'public,max-age=31536000,immutable' \
  "${aws_profile_args[@]}" \
  --region "${AWS_REGION}"

aws s3 cp "${WEB_ROOT}/dist/index.html" "s3://${bucket_name}/index.html" \
  --content-type 'text/html; charset=utf-8' \
  --cache-control 'no-cache' \
  "${aws_profile_args[@]}" \
  --region "${AWS_REGION}"

printf 'result=deployed\nurl=%s\n' "${mini_app_url}"
