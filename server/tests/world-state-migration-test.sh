#!/usr/bin/env bash

set -Eeuo pipefail

REPOSITORY_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
fixture="$(mktemp -d /tmp/spawnpoint-world-state-migration-test.XXXXXXXX)"
cleanup() { rm -rf -- "${fixture}"; }
trap cleanup EXIT

mkdir -p -- "${fixture}/bin" "${fixture}/s3/releases/worlds/legacy" "${fixture}/s3/releases/presets/minecraft"
ln -s -- "${REPOSITORY_ROOT}/server/tests/fake-aws" "${fixture}/bin/aws"
export PATH="${fixture}/bin:${PATH}"
export FAKE_S3_ROOT="${fixture}/s3"
export RELEASE_BUCKET="releases"
export SPAWNPOINT_WORLD_CATALOG="${fixture}/catalog.json"

cat >"${SPAWNPOINT_WORLD_CATALOG}" <<'JSON'
{"schema_version":1,"profile_source":{"repository":"https://github.com/example/config","commit":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},"worlds":[{"id":"legacy","display_name":"Legacy save","profile_id":"industrial"}]}
JSON
cat >"${FAKE_S3_ROOT}/${RELEASE_BUCKET}/worlds/legacy/release.json" <<'JSON'
{"schema_version":1,"world":"legacy","desired_release":"1.2","active_release":"1.1","updated_at":"2026-09-01T00:00:00Z","updated_by":"import","source":"import-world"}
JSON
cat >"${FAKE_S3_ROOT}/${RELEASE_BUCKET}/presets/minecraft/catalog.json" <<'JSON'
{"schema_version":2,"game":"minecraft","source":{"repository":"https://github.com/example/config","commit":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},"presets":[{"id":"industrial","display_name":"Industrial","profile_digest":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","build_status":"ready","releases":["1.1","1.2","1.3"],"latest_release":"1.3"}]}
JSON

tool="${REPOSITORY_ROOT}/scripts/migrate-world-state.sh"
dry="$(${tool} legacy)"
grep -qx 'result=dry_run' <<<"${dry}"
generation_id="$(awk -F= '$1 == "generation_id" { print $2 }' <<<"${dry}")"
state="${FAKE_S3_ROOT}/${RELEASE_BUCKET}/worlds/legacy/generations/${generation_id}/release.json"
record="${FAKE_S3_ROOT}/${RELEASE_BUCKET}/worlds/legacy/world.json"
[[ ! -e "${state}" && ! -e "${record}" ]]

applied="$(${tool} legacy --apply)"
grep -qx 'result=migrated' <<<"${applied}"
jq -e --arg generation "${generation_id}" '
  .schema_version == 2 and .world_id == "legacy" and .generation_id == $generation and
  .desired_release == "1.2" and .active_release == "1.1"
' "${state}" >/dev/null
jq -e --arg generation "${generation_id}" '
  .world_id == "legacy" and .preset.id == "industrial" and
  .current_generation.id == $generation and .current_generation.release == "1.2"
' "${record}" >/dev/null

# An identical retry is harmless; a conflicting durable object is refused.
${tool} legacy --apply >/dev/null
jq '.display_name = "tampered"' "${record}" >"${record}.tmp"
mv -- "${record}.tmp" "${record}"
if ${tool} legacy --apply >/dev/null 2>&1; then
  printf 'expected a conflicting world record to be refused\n' >&2
  exit 1
fi

printf 'world-state-migration-test: ok\n'
