#!/usr/bin/env bash

# Build the host-local catalog for one requested world. Static worlds stay
# byte-for-byte deployment data; a lazily created world is projected from its
# immutable S3 registry record and never from dashboard input.

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
BASE_CATALOG="${SPAWNPOINT_BASE_WORLD_CATALOG:-${SERVER_DIR}/worlds/catalog.json}"
RUNTIME_DIRECTORY="${SPAWNPOINT_RUNTIME_DIRECTORY:-${SERVER_DIR}/runtime}"
RUNTIME_CATALOG="${RUNTIME_DIRECTORY}/world-catalog.json"

[[ $# -eq 1 && "$1" =~ ^[a-z0-9][a-z0-9-]{0,31}$ ]] || {
  printf 'usage: %s <world-id>\n' "$0" >&2
  exit 2
}
world_id="$1"
for command in flock jq; do
  command -v "${command}" >/dev/null 2>&1 || { printf 'error: required command not found: %s\n' "${command}" >&2; exit 1; }
done

mkdir -p -- "${RUNTIME_DIRECTORY}"
exec 9>"${RUNTIME_DIRECTORY}/.world-catalog.lock"
flock 9
stage="$(mktemp "${RUNTIME_DIRECTORY}/.world-catalog.XXXXXXXX")"
record="$(mktemp "${RUNTIME_DIRECTORY}/.world-record.XXXXXXXX")"
cleanup() { rm -f -- "${stage}" "${record}"; }
trap cleanup EXIT

if jq -e --arg id "${world_id}" 'any(.worlds[]; .id == $id)' "${BASE_CATALOG}" >/dev/null; then
  cp -- "${BASE_CATALOG}" "${stage}"
else
  [[ -n "${RELEASE_BUCKET:-}" ]] || { printf 'error: RELEASE_BUCKET is required for a materialized world\n' >&2; exit 1; }
  command -v aws >/dev/null 2>&1 || { printf 'error: required command not found: aws\n' >&2; exit 1; }
  aws s3api get-object --bucket "${RELEASE_BUCKET}" --key "worlds/${world_id}/world.json" "${record}" >/dev/null
  jq -e --arg id "${world_id}" '
    .schema_version == 1 and .world_id == $id and
    (.game | type == "string" and test("^[a-z0-9][a-z0-9-]{0,31}$")) and
    (.display_name | type == "string" and length > 0 and length <= 80) and
    .status == "active" and .connectivity == "zerotier" and .storage_layout == "generation" and
    (.preset.id | type == "string" and test("^[a-z0-9][a-z0-9-]{0,31}$")) and
    (.preset.repository | type == "string" and startswith("https://github.com/")) and
    (.preset.commit | type == "string" and test("^[0-9a-f]{40}$")) and
    (.preset.profile_digest | type == "string" and test("^[0-9a-f]{64}$")) and
    (.current_generation.id | type == "string" and test("^gen-[0-9a-f]{32}$")) and
    (.current_generation.release | type == "string" and test("^[0-9]+\\.[0-9]+$")) and
    ((.current_generation.source // {kind: "preset"}) as $source |
      ($source.kind == "preset") or
      ($source.kind == "backup" and
        ($source.key | type == "string" and test("^worlds/[a-z0-9][a-z0-9-]{0,31}/archives/[A-Za-z0-9._-]+\\.tar\\.zst$")) and
        ($source.checksum | type == "string" and test("^[0-9a-f]{64}$")) and
        ($source.generation_id | type == "string" and test("^gen-[0-9a-f]{32}$"))))
  ' "${record}" >/dev/null || { printf 'error: invalid world registry record: %s\n' "${world_id}" >&2; exit 1; }
  jq --slurpfile record "${record}" '
    .worlds += [{
      id: $record[0].world_id,
      display_name: $record[0].display_name,
      profile_id: $record[0].preset.id,
      game: $record[0].game,
      connectivity: $record[0].connectivity,
      storage_layout: $record[0].storage_layout,
      generation_id: $record[0].current_generation.id,
      release: $record[0].current_generation.release,
      profile_source: {repository: $record[0].preset.repository, commit: $record[0].preset.commit}
    } + (if ($record[0].current_generation.source.kind // "preset") == "backup" then {
      restore: {
        backup_key: $record[0].current_generation.source.key,
        checksum: $record[0].current_generation.source.checksum,
        source_generation_id: $record[0].current_generation.source.generation_id
      }
    } else {} end)
    ]
  ' "${BASE_CATALOG}" >"${stage}"
fi

mv -T -- "${stage}" "${RUNTIME_CATALOG}"
trap - EXIT
rm -f -- "${record}"
printf 'catalog=%s\n' "${RUNTIME_CATALOG}"
