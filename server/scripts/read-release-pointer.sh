#!/usr/bin/env bash

# Read the release state for one exact world wipe. This adapter alone knows the
# S3 layout; callers operate on a world id plus wipe id.

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_common.sh
source "${SCRIPT_DIR}/_common.sh"
# shellcheck source=_s3.sh
source "${SCRIPT_DIR}/_s3.sh"

world_id="${1:-}"
generation_id="${2:-}"

require_command aws
require_command jq
require_safe_world_name "${world_id}"
[[ "${generation_id}" =~ ^gen-[0-9a-f]{32}$ ]] || die "invalid wipe id"
[[ -n "${RELEASE_BUCKET:-}" ]] || die "RELEASE_BUCKET is required"

state_key="worlds/${world_id}/generations/${generation_id}/release.json"
state_file="$(mktemp)"
cleanup() { rm -f -- "${state_file}"; }
trap cleanup EXIT

if ! s3_cli get-object --bucket "${RELEASE_BUCKET}" --key "${state_key}" "${state_file}" >/dev/null 2>&1; then
  log "no release state at s3://${RELEASE_BUCKET}/${state_key}"
  exit 3
fi

jq -e --arg world "${world_id}" --arg generation "${generation_id}" '
  .schema_version == 2 and
  .world_id == $world and
  .generation_id == $generation and
  (.desired_release | type == "string" and test("^[0-9]+\\.[0-9]+$")) and
  ((.active_release == null) or (.active_release | type == "string" and test("^[0-9]+\\.[0-9]+$")))
' "${state_file}" >/dev/null || die "invalid release state: s3://${RELEASE_BUCKET}/${state_key}"

printf 'state_key=%s\n' "${state_key}"
printf 'world_id=%s\n' "${world_id}"
printf 'generation_id=%s\n' "${generation_id}"
printf 'desired_release=%s\n' "$(jq -r '.desired_release' "${state_file}")"
printf 'active_release=%s\n' "$(jq -r '.active_release // "null"' "${state_file}")"
