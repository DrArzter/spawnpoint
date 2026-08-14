#!/usr/bin/env bash

set -Eeuo pipefail

lambda_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
output_dir="${lambda_dir}/dist/lifecycle-coordinator"
archive="${lambda_dir}/dist/lifecycle-coordinator.zip"

mkdir -p "${output_dir}"
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

printf 'result=built\narchive=%s\n' "${archive}"
