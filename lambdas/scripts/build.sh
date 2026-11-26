#!/usr/bin/env bash

set -Eeuo pipefail

lambda_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
output_dir="${lambda_dir}/dist/lifecycle-coordinator"
archive="${lambda_dir}/dist/lifecycle-coordinator.zip"

mkdir -p "${output_dir}" "${lambda_dir}/dist/bot" "${lambda_dir}/dist/notifier" "${lambda_dir}/dist/world-lifecycle" "${lambda_dir}/dist/release-state" "${lambda_dir}/dist/control-plane-projector" "${lambda_dir}/dist/control-plane-subscriptions" "${lambda_dir}/dist/fleet-sweeper" "${lambda_dir}/dist/session-volume-sweeper" "${lambda_dir}/dist/backup-retention" "${lambda_dir}/dist/release-reconciler" "${lambda_dir}/dist/release-retirement" "${lambda_dir}/dist/release-writer" "${lambda_dir}/dist/assistant-worker"
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
  "${lambda_dir}/src/handlers/release-state.ts" \
  --bundle \
  --platform=node \
  --target=node22 \
  --format=cjs \
  --outfile="${lambda_dir}/dist/release-state/index.cjs"

"${lambda_dir}/node_modules/.bin/esbuild" \
  "${lambda_dir}/src/handlers/control-plane-projector.ts" \
  --bundle \
  --platform=node \
  --target=node22 \
  --format=cjs \
  --external:@aws-sdk/* \
  --outfile="${lambda_dir}/dist/control-plane-projector/index.cjs"

"${lambda_dir}/node_modules/.bin/esbuild" \
  "${lambda_dir}/src/handlers/fleet-sweeper.ts" \
  --bundle \
  --platform=node \
  --target=node22 \
  --format=cjs \
  --external:@aws-sdk/* \
  --outfile="${lambda_dir}/dist/fleet-sweeper/index.cjs"

"${lambda_dir}/node_modules/.bin/esbuild" \
  "${lambda_dir}/src/handlers/session-volume-sweeper.ts" \
  --bundle \
  --platform=node \
  --target=node22 \
  --format=cjs \
  --external:@aws-sdk/* \
  --outfile="${lambda_dir}/dist/session-volume-sweeper/index.cjs"

"${lambda_dir}/node_modules/.bin/esbuild" \
  "${lambda_dir}/src/handlers/backup-retention.ts" \
  --bundle \
  --platform=node \
  --target=node22 \
  --format=cjs \
  --external:@aws-sdk/* \
  --outfile="${lambda_dir}/dist/backup-retention/index.cjs"

"${lambda_dir}/node_modules/.bin/esbuild" \
  "${lambda_dir}/src/handlers/release-reconciler.ts" \
  --bundle \
  --platform=node \
  --target=node22 \
  --format=cjs \
  --external:@aws-sdk/* \
  --outfile="${lambda_dir}/dist/release-reconciler/index.cjs"

"${lambda_dir}/node_modules/.bin/esbuild" \
  "${lambda_dir}/src/handlers/release-retirement.ts" \
  --bundle \
  --platform=node \
  --target=node22 \
  --format=cjs \
  --external:@aws-sdk/* \
  --outfile="${lambda_dir}/dist/release-retirement/index.cjs"

# The builder's writer runs in CodeBuild, where no node_modules exist: everything is bundled.
"${lambda_dir}/node_modules/.bin/esbuild" \
  "${lambda_dir}/src/builder/release-writer-main.ts" \
  --bundle \
  --platform=node \
  --target=node22 \
  --format=cjs \
  --outfile="${lambda_dir}/dist/release-writer/index.cjs"

# The assistant's worker bundles its SDK clients, so Converse does not depend on
# the runtime's own copy of the SDK.
"${lambda_dir}/node_modules/.bin/esbuild" \
  "${lambda_dir}/src/handlers/assistant-worker.ts" \
  --bundle \
  --platform=node \
  --target=node22 \
  --format=cjs \
  --outfile="${lambda_dir}/dist/assistant-worker/index.cjs"

"${lambda_dir}/node_modules/.bin/esbuild" \
  "${lambda_dir}/src/handlers/control-plane-subscriptions.ts" \
  --bundle \
  --platform=node \
  --target=node22 \
  --format=cjs \
  --outfile="${lambda_dir}/dist/control-plane-subscriptions/index.cjs"

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

printf 'result=built\narchive=%s\naccess_api=%s\nworld_lifecycle=%s\nrelease_state=%s\ncontrol_plane_projector=%s\nfleet_sweeper=%s\nsession_volume_sweeper=%s\nbackup_retention=%s\nrelease_reconciler=%s\nrelease_retirement=%s\nrelease_writer=%s\ncontrol_plane_subscriptions=%s\nassistant_worker=%s\nbot=%s\nnotifier=%s\n' \
  "${archive}" \
  "${lambda_dir}/dist/access-api/index.cjs" \
  "${lambda_dir}/dist/world-lifecycle/index.cjs" \
  "${lambda_dir}/dist/release-state/index.cjs" \
  "${lambda_dir}/dist/control-plane-projector/index.cjs" \
  "${lambda_dir}/dist/fleet-sweeper/index.cjs" \
  "${lambda_dir}/dist/session-volume-sweeper/index.cjs" \
  "${lambda_dir}/dist/backup-retention/index.cjs" \
  "${lambda_dir}/dist/release-reconciler/index.cjs" \
  "${lambda_dir}/dist/release-retirement/index.cjs" \
  "${lambda_dir}/dist/release-writer/index.cjs" \
  "${lambda_dir}/dist/control-plane-subscriptions/index.cjs" \
  "${lambda_dir}/dist/assistant-worker/index.cjs" \
  "${lambda_dir}/dist/bot/index.cjs" \
  "${lambda_dir}/dist/notifier/index.mjs"
