#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_common.sh
source "${SCRIPT_DIR}/_common.sh"
# shellcheck source=_s3.sh
source "${SCRIPT_DIR}/_s3.sh"

archive="${1:-}"
world_name="${WORLD_NAME:-world}"

[[ -n "${archive}" ]] || die "usage: upload-world-backup.sh <archive.tar.zst>"
require_command aws
require_command base64
require_command openssl
require_backup_bucket
require_safe_world_name "${world_name}"

archive="$(realpath -m -- "${archive}")"
"${SCRIPT_DIR}/verify-archive.sh" "${archive}" >/dev/null

archive_name="$(basename -- "${archive}")"
[[ "${archive_name}" =~ ^[A-Za-z0-9._-]+\.tar\.zst$ ]] || die "unsafe archive name: ${archive_name}"

digest="$(sha256sum -- "${archive}" | awk '{print $1}')"
digest_base64="$(archive_checksum_base64 "${archive}")"
archive_bytes="$(stat --format '%s' -- "${archive}")"
key_prefix="${BACKUP_KEY_PREFIX:-worlds/${world_name}/archives}"
key_prefix="${key_prefix#/}"
key_prefix="${key_prefix%/}"
[[ -n "${key_prefix}" && "${key_prefix}" != *".."* ]] || die "unsafe BACKUP_KEY_PREFIX: ${key_prefix}"
object_key="${key_prefix}/${archive_name%.tar.zst}-${digest}.tar.zst"

metadata="sha256=${digest},world=${world_name},archive-name=${archive_name}"
if [[ -n "${WORLD_GENERATION_ID:-}" ]]; then
  [[ "${WORLD_GENERATION_ID}" =~ ^gen-[0-9a-f]{32}$ ]] || die "invalid WORLD_GENERATION_ID"
  metadata="${metadata},generation=${WORLD_GENERATION_ID}"
fi
if [[ -n "${WORLD_RELEASE:-}" ]]; then
  [[ "${WORLD_RELEASE}" =~ ^[0-9]+\.[0-9]+$ ]] || die "invalid WORLD_RELEASE"
  metadata="${metadata},release=${WORLD_RELEASE}"
fi

if head_output="$(head_backup_object "${object_key}" 2>/dev/null)"; then
  IFS=$'\t' read -r remote_hex remote_base64 remote_bytes <<<"${head_output}"
  if [[ "${remote_hex}" == "${digest}" && "${remote_base64}" == "${digest_base64}" && "${remote_bytes}" == "${archive_bytes}" ]]; then
    printf 'result=already_present\n'
    printf 'bucket=%s\n' "${BACKUP_BUCKET}"
    printf 'object_key=%s\n' "${object_key}"
    printf 'checksum=%s\n' "${digest}"
    printf 'archive_bytes=%s\n' "${archive_bytes}"
    exit 0
  fi
  die "immutable backup key already exists with different content: s3://${BACKUP_BUCKET}/${object_key}"
fi

s3_cli put-object \
  --bucket "${BACKUP_BUCKET}" \
  --key "${object_key}" \
  --body "${archive}" \
  --checksum-algorithm SHA256 \
  --checksum-sha256 "${digest_base64}" \
  --metadata "${metadata}" \
  >/dev/null

verify_remote_backup "${object_key}" "${digest}" "${digest_base64}" "${archive_bytes}"

printf 'result=uploaded\n'
printf 'bucket=%s\n' "${BACKUP_BUCKET}"
printf 'object_key=%s\n' "${object_key}"
printf 'checksum=%s\n' "${digest}"
printf 'archive_bytes=%s\n' "${archive_bytes}"
