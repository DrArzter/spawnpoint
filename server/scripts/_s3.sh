#!/usr/bin/env bash

# Shared S3 CLI adapter for the host-side backup scripts.
# shellcheck shell=bash

S3_REGION="${AWS_REGION:-eu-central-1}"
S3_GLOBAL_ARGS=(--region "${S3_REGION}" --no-cli-pager)

if [[ -n "${S3_ENDPOINT_URL:-}" ]]; then
  S3_GLOBAL_ARGS+=(--endpoint-url "${S3_ENDPOINT_URL}")
fi

s3_cli() {
  aws "${S3_GLOBAL_ARGS[@]}" s3api "$@"
}

require_backup_bucket() {
  [[ -n "${BACKUP_BUCKET:-}" ]] || die "BACKUP_BUCKET is required"
  [[ "${BACKUP_BUCKET}" =~ ^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$ ]] || die "invalid BACKUP_BUCKET: ${BACKUP_BUCKET}"
}

require_safe_world_name() {
  local world_name="$1"
  [[ "${world_name}" =~ ^[A-Za-z0-9._-]+$ ]] || die "unsafe WORLD_NAME: ${world_name}"
}

archive_checksum_base64() {
  local archive="$1"
  openssl dgst -sha256 -binary "${archive}" | base64 | tr -d '\n'
}

head_backup_object() {
  local key="$1"
  s3_cli head-object \
    --bucket "${BACKUP_BUCKET}" \
    --key "${key}" \
    --checksum-mode ENABLED \
    --query '[Metadata.sha256,ChecksumSHA256,ContentLength]' \
    --output text
}

verify_remote_backup() {
  local key="$1"
  local expected_hex="$2"
  local expected_base64="$3"
  local expected_bytes="$4"
  local head_output remote_hex remote_base64 remote_bytes

  head_output="$(head_backup_object "${key}")" || die "could not inspect uploaded backup: s3://${BACKUP_BUCKET}/${key}"
  IFS=$'\t' read -r remote_hex remote_base64 remote_bytes <<<"${head_output}"

  [[ "${remote_hex}" == "${expected_hex}" ]] || die "S3 backup metadata checksum does not match local archive"
  [[ "${remote_base64}" == "${expected_base64}" ]] || die "S3 object checksum does not match local archive"
  [[ "${remote_bytes}" == "${expected_bytes}" ]] || die "S3 backup size does not match local archive"
}
