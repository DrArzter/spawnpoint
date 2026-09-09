#!/usr/bin/env bash

# Purge deletes durable S3 state immediately. A stopped host cannot erase its
# now-unreferenced generation directories, so the next boot reconciles the
# retained purge markers before preparing a new generation with the same ID.

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_worlds.sh
source "${SCRIPT_DIR}/_worlds.sh"

[[ $# -eq 1 && "$1" =~ ^[a-z0-9][a-z0-9-]{0,31}$ ]] || {
  printf 'usage: %s <world-id>\n' "$0" >&2
  exit 2
}
[[ -n "${RELEASE_BUCKET:-}" ]] || { printf 'error: RELEASE_BUCKET is required\n' >&2; exit 1; }
for command in aws flock jq; do
  command -v "${command}" >/dev/null 2>&1 || { printf 'error: required command not found: %s\n' "${command}" >&2; exit 1; }
done

world_id="$1"
load_world "${world_id}"
[[ "${WORLD_STORAGE_LAYOUT}" == "generation" ]] || { printf 'result=legacy_world\n'; exit 0; }

world_root="${WORLDS_DIRECTORY}/${world_id}"
generations_root="${world_root}/generations"
[[ ! -L "${world_root}" && ! -L "${generations_root}" ]] || {
  printf 'error: generation storage contains a symbolic link\n' >&2
  exit 1
}
mkdir -p -- "${generations_root}"
exec 9>"${WORLDS_DIRECTORY}/.spawnpoint-worlds.lock"
flock -n 9 || { printf 'error: another operation is preparing a world\n' >&2; exit 1; }

keys="$(aws s3api list-objects-v2 --bucket "${RELEASE_BUCKET}" --prefix "worlds/${world_id}/purges/" \
  --query 'Contents[].Key' --output text)"
[[ "${keys}" != "None" ]] || keys=""
removed=0
for key in ${keys}; do
  [[ "${key}" =~ ^worlds/${world_id}/purges/gen-[0-9a-f]{32}\.json$ ]] || {
    printf 'error: invalid purge marker key: %s\n' "${key}" >&2
    exit 1
  }
  marker="$(mktemp "${WORLDS_DIRECTORY}/.purge-marker.XXXXXXXX")"
  trap 'rm -f -- "${marker:-}"' EXIT
  aws s3api get-object --bucket "${RELEASE_BUCKET}" --key "${key}" "${marker}" >/dev/null
  jq -e --arg world_id "${world_id}" '
    .schema_version == 1 and .world_id == $world_id and .status == "completed" and
    (.target_generation_id | type == "string" and test("^gen-[0-9a-f]{32}$")) and
    (.generation_ids | type == "array" and length > 0 and all(.[]; type == "string" and test("^gen-[0-9a-f]{32}$")))
  ' "${marker}" >/dev/null || { printf 'error: invalid purge marker: %s\n' "${key}" >&2; exit 1; }
  while IFS= read -r generation_id; do
    target="${generations_root}/${generation_id}"
    [[ "${target}" == "${generations_root}/gen-"* ]] || { printf 'error: purge target escaped generation root\n' >&2; exit 1; }
    if [[ -e "${target}" || -L "${target}" ]]; then
      rm -rf -- "${target}"
      removed=$((removed + 1))
    fi
  done < <(jq -r '.generation_ids[]' "${marker}")
  rm -f -- "${marker}"
  trap - EXIT
done

printf 'result=reconciled\n'
printf 'removed=%s\n' "${removed}"
