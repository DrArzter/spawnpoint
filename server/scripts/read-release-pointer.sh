#!/usr/bin/env bash

# Read a world's release pointer (ADR-0030) from the release bucket.
# Exit codes: 0 pointer read, 3 pointer absent (a legitimate pre-import state),
# anything else a real failure. Callers branch on 3; they never parse stderr.

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_common.sh
source "${SCRIPT_DIR}/_common.sh"
# shellcheck source=_s3.sh
source "${SCRIPT_DIR}/_s3.sh"

world_name="${1:-${WORLD_NAME:-world}}"

require_command aws
require_command jq
require_safe_world_name "${world_name}"
[[ -n "${RELEASE_BUCKET:-}" ]] || die "RELEASE_BUCKET is required"

pointer_key="worlds/${world_name}/release.json"
pointer_file="$(mktemp)"
cleanup() {
  rm -f -- "${pointer_file}"
}
trap cleanup EXIT

if ! s3_cli get-object \
  --bucket "${RELEASE_BUCKET}" \
  --key "${pointer_key}" \
  "${pointer_file}" >/dev/null 2>&1; then
  log "no release pointer at s3://${RELEASE_BUCKET}/${pointer_key}"
  exit 3
fi

jq -e '
  .schema_version == 1 and
  (.world | type == "string") and
  (.desired_release | type == "string" and test("^[0-9]+\\.[0-9]+$")) and
  ((.active_release == null) or (.active_release | type == "string" and test("^[0-9]+\\.[0-9]+$")))
' "${pointer_file}" >/dev/null || die "invalid release pointer: s3://${RELEASE_BUCKET}/${pointer_key}"

[[ "$(jq -r '.world' "${pointer_file}")" == "${world_name}" ]] ||
  die "release pointer names a different world: s3://${RELEASE_BUCKET}/${pointer_key}"

printf 'pointer_key=%s\n' "${pointer_key}"
printf 'desired_release=%s\n' "$(jq -r '.desired_release' "${pointer_file}")"
printf 'active_release=%s\n' "$(jq -r '.active_release // "null"' "${pointer_file}")"
