#!/usr/bin/env bash

set -Eeuo pipefail

repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
lambda_root="${repository_root}/lambdas"

(
  cd -- "${lambda_root}"
  npm run build
)

functions=(
  "lifecycle-coordinator:spawnpoint-lifecycle-coordinator-v2"
  "access-api:spawnpoint-access-api"
  "world-lifecycle:spawnpoint-world-lifecycle"
  "release-state:spawnpoint-release-state"
  "control-plane-projector:spawnpoint-control-plane-projector"
  "bot:spawnpoint-telegram-bot"
  "notifier:spawnpoint-notifier"
)

for specification in "${functions[@]}"; do
  bundle="${specification%%:*}"
  function_name="${specification#*:}"
  bundle_dir="${lambda_root}/dist/${bundle}"
  archive="${lambda_root}/dist/${bundle}.zip"

  find "${bundle_dir}" -type f -exec touch -t 198001010000 {} +
  rm -f -- "${archive}"
  (
    cd -- "${bundle_dir}"
    zip -X -q -r "${archive}" .
  )

  local_hash="$(openssl dgst -sha256 -binary "${archive}" | base64 -w0)"
  remote_hash="$(aws lambda get-function-configuration \
    --function-name "${function_name}" \
    --query CodeSha256 \
    --output text)"

  if [[ "${local_hash}" == "${remote_hash}" ]]; then
    printf 'result=unchanged\nfunction=%s\n' "${function_name}"
    continue
  fi

  aws lambda update-function-code \
    --function-name "${function_name}" \
    --zip-file "fileb://${archive}" \
    --no-cli-pager >/dev/null
  aws lambda wait function-updated-v2 --function-name "${function_name}"
  printf 'result=deployed\nfunction=%s\n' "${function_name}"
done
