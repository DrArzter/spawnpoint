#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_common.sh
source "${SCRIPT_DIR}/_common.sh"
# shellcheck source=_s3.sh
source "${SCRIPT_DIR}/_s3.sh"

object_key="${1:-}"
destination="${2:-}"

[[ -n "${object_key}" && -n "${destination}" ]] || die "usage: download-world-backup.sh <object-key> <new-archive.tar.zst>"
require_command aws
require_command base64
require_command jq
require_command openssl
require_backup_bucket

destination="$(realpath -m -- "${destination}")"
[[ ! -e "${destination}" ]] || die "destination already exists: ${destination}"
[[ ! -e "${destination}.sha256" ]] || die "destination checksum already exists: ${destination}.sha256"
mkdir -p -- "$(dirname -- "${destination}")"

head_output="$(head_backup_object "${object_key}")" || die "backup does not exist: s3://${BACKUP_BUCKET}/${object_key}"
IFS=$'\t' read -r expected_hex expected_base64 expected_bytes <<<"${head_output}"
[[ "${expected_hex}" =~ ^[0-9a-f]{64}$ ]] || die "backup is missing valid SHA-256 metadata"
[[ -n "${expected_base64}" && "${expected_base64}" != "None" ]] || die "backup is missing S3 SHA-256 checksum"
[[ "${expected_bytes}" =~ ^[0-9]+$ && "${expected_bytes}" -gt 0 ]] || die "backup has invalid content length"

temporary_archive="$(mktemp --tmpdir="$(dirname -- "${destination}")" '.world-download.XXXXXX.tar.zst')"
cleanup() {
  rm -f -- "${temporary_archive}"
}
trap cleanup EXIT

get_output="$(s3_cli get-object \
  --bucket "${BACKUP_BUCKET}" \
  --key "${object_key}" \
  --checksum-mode ENABLED \
  "${temporary_archive}")" || die "could not download backup: s3://${BACKUP_BUCKET}/${object_key}"

download_checksum="$(jq -r '.ChecksumSHA256 // empty' <<<"${get_output}")"
[[ "${download_checksum}" == "${expected_base64}" ]] || die "checksum returned by S3 changed between HEAD and GET"
[[ "$(stat --format '%s' -- "${temporary_archive}")" == "${expected_bytes}" ]] || die "downloaded backup size does not match S3"

actual_hex="$(sha256sum -- "${temporary_archive}" | awk '{print $1}')"
actual_base64="$(archive_checksum_base64 "${temporary_archive}")"
[[ "${actual_hex}" == "${expected_hex}" ]] || die "downloaded backup SHA-256 does not match S3 metadata"
[[ "${actual_base64}" == "${expected_base64}" ]] || die "downloaded backup SHA-256 does not match S3 checksum"

mv -- "${temporary_archive}" "${destination}"
trap - EXIT
printf '%s  %s\n' "${actual_hex}" "$(basename -- "${destination}")" >"${destination}.sha256"
"${SCRIPT_DIR}/verify-archive.sh" "${destination}" >/dev/null

printf 'result=downloaded_and_verified\n'
printf 'bucket=%s\n' "${BACKUP_BUCKET}"
printf 'object_key=%s\n' "${object_key}"
printf 'archive=%s\n' "${destination}"
printf 'checksum=%s\n' "${actual_hex}"
printf 'archive_bytes=%s\n' "${expected_bytes}"
