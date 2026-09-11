#!/usr/bin/env bash

# Copy one legacy globally-versioned release into its preset-scoped canonical
# namespace. The manifest is copied last, because its existence is the release
# commit marker. Legacy keys are deliberately retained as rollback material;
# runtime readers never consult them after the cutover.

set -Eeuo pipefail

profile="${AWS_PROFILE:-spawnpoint}"
region="${AWS_REGION:-eu-central-1}"
apply=false

usage() {
  printf 'usage: %s <game> <preset> <release> [--apply]\n' "$0" >&2
}

[[ $# -eq 3 || ( $# -eq 4 && "$4" == "--apply" ) ]] || { usage; exit 2; }
game="$1"
preset="$2"
release="$3"
[[ $# -eq 3 ]] || apply=true

[[ "${game}" =~ ^[a-z0-9][a-z0-9-]{0,31}$ ]] || { usage; exit 2; }
[[ "${preset}" =~ ^[a-z0-9][a-z0-9-]{0,31}$ ]] || { usage; exit 2; }
[[ "${release}" =~ ^[0-9]+\.[0-9]+$ ]] || { usage; exit 2; }
for command in aws jq sha256sum; do
  command -v "${command}" >/dev/null 2>&1 || { printf 'error: required command not found: %s\n' "${command}" >&2; exit 1; }
done

if [[ -z "${RELEASE_BUCKET:-}" ]]; then
  account_id="$(aws sts get-caller-identity --profile "${profile}" --region "${region}" --query Account --output text)"
  [[ "${account_id}" =~ ^[0-9]{12}$ ]] || { printf 'error: could not resolve AWS account id\n' >&2; exit 1; }
  RELEASE_BUCKET="spawnpoint-releases-${account_id}"
fi

legacy_prefix="releases/${release}"
canonical_prefix="releases/${game}/${preset}/${release}"
workspace="$(mktemp -d /tmp/spawnpoint-release-layout.XXXXXXXX)"
cleanup() { rm -rf -- "${workspace}"; }
trap cleanup EXIT

manifest="${workspace}/manifest.json"
aws s3api get-object --profile "${profile}" --region "${region}" \
  --bucket "${RELEASE_BUCKET}" --key "${legacy_prefix}/manifest.json" "${manifest}" >/dev/null
jq -e --arg game "${game}" --arg preset "${preset}" --arg release "${release}" '
  .schema_version == 1 and (.game // "minecraft") == $game and .release == $release and .source_profile.id == $preset
' "${manifest}" >/dev/null || {
  printf 'error: legacy manifest does not identify %s/%s@%s\n' "${game}" "${preset}" "${release}" >&2
  exit 1
}
normalized_manifest="${workspace}/manifest.normalized.json"
jq --arg game "${game}" '.game = (.game // $game)' "${manifest}" >"${normalized_manifest}"

mapfile -t payload_keys < <(
  aws s3api list-objects-v2 --profile "${profile}" --region "${region}" \
    --bucket "${RELEASE_BUCKET}" --prefix "${legacy_prefix}/mods/" \
    --query 'Contents[].Key' --output text | tr '\t' '\n' | sed '/^$/d;/^None$/d' | sort
)
if aws s3api head-object --profile "${profile}" --region "${region}" \
  --bucket "${RELEASE_BUCKET}" --key "packs/${release}.zip" >/dev/null 2>&1; then
  payload_keys+=("packs/${release}.zip")
fi

head_identity() {
  aws s3api head-object --profile "${profile}" --region "${region}" \
    --bucket "${RELEASE_BUCKET}" --key "$1" \
    --query '[Metadata.sha256,ContentLength]' --output text
}

copy_verified() {
  local source="$1" destination="$2" source_identity destination_identity
  source_identity="$(head_identity "${source}")"
  if destination_identity="$(head_identity "${destination}" 2>/dev/null)"; then
    [[ "${destination_identity}" == "${source_identity}" ]] || {
      printf 'error: canonical destination exists with different content: s3://%s/%s\n' "${RELEASE_BUCKET}" "${destination}" >&2
      exit 1
    }
    printf 'verified=%s\n' "${destination}"
    return
  fi
  ${apply} || { printf 'copy=%s -> %s\n' "${source}" "${destination}"; return; }
  aws s3api copy-object --profile "${profile}" --region "${region}" \
    --bucket "${RELEASE_BUCKET}" --copy-source "${RELEASE_BUCKET}/${source}" --key "${destination}" >/dev/null
  destination_identity="$(head_identity "${destination}")"
  [[ "${destination_identity}" == "${source_identity}" ]] || {
    printf 'error: copied object failed verification: s3://%s/%s\n' "${RELEASE_BUCKET}" "${destination}" >&2
    exit 1
  }
  printf 'copied=%s\n' "${destination}"
}

for source in "${payload_keys[@]}"; do
  if [[ "${source}" == "packs/${release}.zip" ]]; then
    destination="${canonical_prefix}/client.zip"
  else
    destination="${canonical_prefix}/${source#"${legacy_prefix}/"}"
  fi
  copy_verified "${source}" "${destination}"
done
publish_manifest() {
  local destination="${canonical_prefix}/manifest.json"
  local expected_digest remote_manifest remote_digest
  expected_digest="$(sha256sum -- "${normalized_manifest}")"
  expected_digest="${expected_digest%% *}"
  remote_manifest="${workspace}/manifest.remote.json"
  if aws s3api get-object --profile "${profile}" --region "${region}" \
    --bucket "${RELEASE_BUCKET}" --key "${destination}" "${remote_manifest}" >/dev/null 2>&1; then
    remote_digest="$(sha256sum -- "${remote_manifest}")"
    remote_digest="${remote_digest%% *}"
    [[ "${remote_digest}" == "${expected_digest}" ]] || {
      printf 'error: canonical manifest exists with different content: s3://%s/%s\n' "${RELEASE_BUCKET}" "${destination}" >&2
      exit 1
    }
    printf 'verified=%s\n' "${destination}"
    return
  fi
  ${apply} || { printf 'put=%s\n' "${destination}"; return; }
  aws s3api put-object --profile "${profile}" --region "${region}" \
    --bucket "${RELEASE_BUCKET}" --key "${destination}" --body "${normalized_manifest}" \
    --metadata "sha256=${expected_digest},game=${game},preset=${preset},release=${release},file=manifest.json" \
    --server-side-encryption AES256 --content-type application/json >/dev/null
  aws s3api get-object --profile "${profile}" --region "${region}" \
    --bucket "${RELEASE_BUCKET}" --key "${destination}" "${remote_manifest}" >/dev/null
  remote_digest="$(sha256sum -- "${remote_manifest}")"
  remote_digest="${remote_digest%% *}"
  [[ "${remote_digest}" == "${expected_digest}" ]] || {
    printf 'error: uploaded manifest failed verification: s3://%s/%s\n' "${RELEASE_BUCKET}" "${destination}" >&2
    exit 1
  }
  printf 'uploaded=%s\n' "${destination}"
}

publish_manifest

printf 'result=%s\n' "$(${apply} && printf migrated || printf dry_run)"
printf 'release=%s@%s\n' "${preset}" "${release}"
printf 'canonical_prefix=%s\n' "${canonical_prefix}"
