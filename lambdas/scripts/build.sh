#!/usr/bin/env bash

set -Eeuo pipefail

lambda_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
output_dir="${lambda_dir}/dist/lifecycle-coordinator"
archive="${lambda_dir}/dist/lifecycle-coordinator.zip"

mkdir -p "${output_dir}" "${lambda_dir}/dist/bot" "${lambda_dir}/dist/notifier" "${lambda_dir}/dist/world-lifecycle"
"${lambda_dir}/node_modules/.bin/esbuild" \
  "${lambda_dir}/src/handlers/lifecycle-coordinator.ts" \
  --bundle \
  --platform=node \
  --target=node24 \
  --format=cjs \
  --outfile="${output_dir}/index.cjs"

rm -f "${output_dir}/index.mjs"
touch -t 198001010000 "${output_dir}/index.cjs"
rm -f "${archive}"
zip -X -j -q "${archive}" "${output_dir}/index.cjs"

mkdir -p "${lambda_dir}/dist/access-api"
"${lambda_dir}/node_modules/.bin/esbuild" \
  "${lambda_dir}/src/handlers/access-api.ts" \
  --bundle \
  --platform=node \
  --target=node22 \
  --format=cjs \
  --external:@aws-sdk/* \
  --outfile="${lambda_dir}/dist/access-api/index.cjs"

"${lambda_dir}/node_modules/.bin/esbuild" \
  "${lambda_dir}/src/handlers/world-lifecycle.ts" \
  --bundle \
  --platform=node \
  --target=node22 \
  --format=cjs \
  --outfile="${lambda_dir}/dist/world-lifecycle/index.cjs"

"${lambda_dir}/node_modules/.bin/esbuild" \
  "${lambda_dir}/src/bot/handler.ts" \
  --bundle \
  --platform=node \
  --target=node22 \
  --format=cjs \
  --external:@aws-sdk/* \
  --outfile="${lambda_dir}/dist/bot/index.cjs"

rm -f "${lambda_dir}/dist/bot/index.mjs"

"${lambda_dir}/node_modules/.bin/esbuild" \
  "${lambda_dir}/src/bot/notifier.ts" \
  --bundle \
  --platform=node \
  --target=node22 \
  --format=esm \
  --external:@aws-sdk/* \
  --outfile="${lambda_dir}/dist/notifier/index.mjs"

printf 'result=built\narchive=%s\naccess_api=%s\nworld_lifecycle=%s\nbot=%s\nnotifier=%s\n' \
  "${archive}" \
  "${lambda_dir}/dist/access-api/index.cjs" \
  "${lambda_dir}/dist/world-lifecycle/index.cjs" \
  "${lambda_dir}/dist/bot/index.cjs" \
  "${lambda_dir}/dist/notifier/index.mjs"
