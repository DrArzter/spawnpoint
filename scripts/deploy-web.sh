#!/usr/bin/env bash

set -Eeuo pipefail

REPOSITORY_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
TERRAFORM_BIN="${TERRAFORM_BIN:-terraform}"
AWS_PROFILE_NAME="${AWS_PROFILE_NAME:-spawnpoint}"
AWS_REGION_NAME="${AWS_REGION_NAME:-eu-central-1}"
WEB_ROOT="${REPOSITORY_ROOT}/web"
TERRAFORM_ROOT="${REPOSITORY_ROOT}/infra/terraform-web"

cd -- "${WEB_ROOT}"
npm run build

bucket_name="$(${TERRAFORM_BIN} -chdir="${TERRAFORM_ROOT}" output -raw bucket_name)"
mini_app_url="$(${TERRAFORM_BIN} -chdir="${TERRAFORM_ROOT}" output -raw mini_app_url)"

aws s3 sync "${WEB_ROOT}/dist/assets" "s3://${bucket_name}/assets" \
  --delete \
  --cache-control 'public,max-age=31536000,immutable' \
  --profile "${AWS_PROFILE_NAME}" \
  --region "${AWS_REGION_NAME}"

aws s3 cp "${WEB_ROOT}/dist/index.html" "s3://${bucket_name}/index.html" \
  --content-type 'text/html; charset=utf-8' \
  --cache-control 'no-cache' \
  --profile "${AWS_PROFILE_NAME}" \
  --region "${AWS_REGION_NAME}"

printf 'result=deployed\nurl=%s\n' "${mini_app_url}"
