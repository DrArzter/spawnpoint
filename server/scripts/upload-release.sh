#!/usr/bin/env bash

# Publish an immutable release — payload JARs plus manifest — to the release
# bucket. Upload order is deliberate: mods first, manifest last, so a partial
# upload can never present itself as a complete release. The manifest's
# existence is the commit marker.

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_common.sh
source "${SCRIPT_DIR}/_common.sh"
# shellcheck source=_s3.sh
source "${SCRIPT_DIR}/_s3.sh"

manifest="${1:-}"
[[ -n "${manifest}" ]] || die "usage: upload-release.sh <manifest.json> (payload defaults to the manifest's directory; override with RELEASE_SOURCE_DIR)"

require_command aws
require_command jq
require_command base64
require_command openssl
require_command sha256sum

[[ -n "${RELEASE_BUCKET:-}" ]] || die "RELEASE_BUCKET is required"
[[ "${RELEASE_BUCKET}" =~ ^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$ ]] || die "invalid RELEASE_BUCKET: ${RELEASE_BUCKET}"

manifest="$(realpath -e -- "${manifest}")"
source_dir="$(realpath -e -- "${RELEASE_SOURCE_DIR:-$(dirname -- "${manifest}")}")"
[[ -f "${manifest}" && ! -L "${manifest}" ]] || die "manifest must be a regular non-symlink file: ${manifest}"
[[ -d "${source_dir}/mods" && ! -L "${source_dir}/mods" ]] || die "release mods directory is missing or is a symlink: ${source_dir}/mods"

# The same shape rules reconcile-release.sh enforces before trusting a manifest.
jq -e '
  .schema_version == 1 and
  (.release | type == "string" and test("^[0-9]+\\.[0-9]+$")) and
  (.server.mods | type == "array" and length > 0) and
  all(.server.mods[];
    (.file | type == "string" and test("^[^/\\\\]+\\.jar$")) and
    (.sha256 | type == "string" and test("^[0-9a-f]{64}$")) and
    (.bytes | type == "number" and floor == . and . >= 0)
  ) and
  (([.server.mods[].file] | unique | length) == (.server.mods | length))
' "${manifest}" >/dev/null || die "invalid release manifest: ${manifest}"

release="$(jq -r '.release' "${manifest}")"
mods_count="$(jq -r '.server.mods | length' "${manifest}")"
manifest_key="releases/${release}/manifest.json"
manifest_digest="$(sha256sum -- "${manifest}" | awk '{print $1}')"

head_release_object() {
  local key="$1"
  s3_cli head-object \
    --bucket "${RELEASE_BUCKET}" \
    --key "${key}" \
    --checksum-mode ENABLED \
    --query '[Metadata.sha256,ChecksumSHA256,ContentLength]' \
    --output text
}

upload_release_object() {
  local key="$1" body="$2" digest="$3" extra_metadata="$4"
  local digest_base64 bytes head_output remote_hex remote_base64 remote_bytes
  digest_base64="$(archive_checksum_base64 "${body}")"
  bytes="$(stat --format '%s' -- "${body}")"

  s3_cli put-object \
    --bucket "${RELEASE_BUCKET}" \
    --key "${key}" \
    --body "${body}" \
    --checksum-algorithm SHA256 \
    --checksum-sha256 "${digest_base64}" \
    --metadata "sha256=${digest},release=${release},${extra_metadata}" \
    >/dev/null

  head_output="$(head_release_object "${key}")" || die "could not inspect uploaded object: s3://${RELEASE_BUCKET}/${key}"
  IFS=$'\t' read -r remote_hex remote_base64 remote_bytes <<<"${head_output}"
  [[ "${remote_hex}" == "${digest}" && "${remote_base64}" == "${digest_base64}" && "${remote_bytes}" == "${bytes}" ]] ||
    die "uploaded object failed verification: s3://${RELEASE_BUCKET}/${key}"
}

# An existing manifest is the immutability gate. Identity is the deployment
# content — release, versions and the mods entries — not the whole document:
# created_at and the changelog are descriptive, and two imports of the same
# pack legitimately differ there (see server/releases/README.md).
canonical_manifest() {
  jq -S '{release, minecraft_version, loader, server}' "$1"
}

if head_release_object "${manifest_key}" >/dev/null 2>&1; then
  remote_manifest="$(mktemp)"
  trap 'rm -f -- "${remote_manifest}"' EXIT
  s3_cli get-object \
    --bucket "${RELEASE_BUCKET}" \
    --key "${manifest_key}" \
    "${remote_manifest}" >/dev/null || die "could not fetch the existing manifest: s3://${RELEASE_BUCKET}/${manifest_key}"
  [[ "$(canonical_manifest "${manifest}")" == "$(canonical_manifest "${remote_manifest}")" ]] ||
    die "release ${release} already exists with different content: s3://${RELEASE_BUCKET}/${manifest_key}"
  printf 'result=already_present\n'
  printf 'bucket=%s\n' "${RELEASE_BUCKET}"
  printf 'release=%s\n' "${release}"
  printf 'manifest_key=%s\n' "${manifest_key}"
  printf 'mods=%s\n' "${mods_count}"
  exit 0
fi

while IFS=$'\t' read -r filename expected_sha expected_bytes; do
  source_file="${source_dir}/mods/${filename}"
  [[ -f "${source_file}" && ! -L "${source_file}" ]] || die "release file is missing or is a symlink: ${source_file}"

  actual_bytes="$(stat --format '%s' -- "${source_file}")"
  [[ "${actual_bytes}" == "${expected_bytes}" ]] || die "size mismatch for ${filename}: expected ${expected_bytes}, got ${actual_bytes}"
  actual_sha="$(sha256sum -- "${source_file}")"
  actual_sha="${actual_sha%% *}"
  [[ "${actual_sha}" == "${expected_sha}" ]] || die "SHA-256 mismatch for ${filename}"

  upload_release_object "releases/${release}/mods/${filename}" "${source_file}" "${expected_sha}" "file=${filename}"
done < <(jq -r '.server.mods[] | [.file, .sha256, (.bytes | tostring)] | @tsv' "${manifest}")

upload_release_object "${manifest_key}" "${manifest}" "${manifest_digest}" "file=manifest.json"

printf 'result=uploaded\n'
printf 'bucket=%s\n' "${RELEASE_BUCKET}"
printf 'release=%s\n' "${release}"
printf 'manifest_key=%s\n' "${manifest_key}"
printf 'mods=%s\n' "${mods_count}"
