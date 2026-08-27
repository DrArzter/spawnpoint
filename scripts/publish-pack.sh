#!/usr/bin/env bash

# Publish the client pack for a release that already exists in the bucket.
# Releases cut before packs were part of publication — and any release cut by a
# path that skipped them — have a manifest and a payload but no packs/<release>.zip,
# which is what the bot's /pack serves. This downloads the verified payload and
# republishes, which fills the missing pack and touches nothing else: the
# manifest gate refuses to change an existing release.

set -Eeuo pipefail

REPOSITORY_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
SERVER_SCRIPTS="${REPOSITORY_ROOT}/server/scripts"

[[ $# -eq 1 ]] || {
  cat >&2 <<'EOF'
usage: publish-pack.sh <release>

Environment:
  AWS_PROFILE      defaults to spawnpoint
  AWS_REGION       defaults to eu-central-1
  RELEASE_BUCKET   defaults to spawnpoint-releases-<account-id>
EOF
  exit 2
}

release="$1"
[[ "${release}" =~ ^[0-9]+\.[0-9]+$ ]] || {
  printf 'error: release must use MAJOR.MINOR: %s\n' "${release}" >&2
  exit 1
}

export AWS_PROFILE="${AWS_PROFILE:-spawnpoint}"
export AWS_REGION="${AWS_REGION:-eu-central-1}"

for command in aws jq sha256sum zip; do
  command -v "${command}" >/dev/null 2>&1 || {
    printf 'error: required command not found: %s\n' "${command}" >&2
    exit 1
  }
done

if [[ -z "${RELEASE_BUCKET:-}" ]]; then
  account_id="$(aws sts get-caller-identity --query Account --output text)"
  [[ "${account_id}" =~ ^[0-9]{12}$ ]] || {
    printf 'error: could not resolve the AWS account id\n' >&2
    exit 1
  }
fi
export RELEASE_BUCKET="${RELEASE_BUCKET:-spawnpoint-releases-${account_id}}"

staging="$(mktemp -d /tmp/spawnpoint-publish-pack.XXXXXXXX)"
cleanup() {
  rm -rf -- "${staging}"
}
trap cleanup EXIT

# Verified download: every file is checked against the manifest's hashes, so
# the pack can only ever contain the release's own bytes.
"${SERVER_SCRIPTS}/download-release.sh" "${release}" "${staging}/payload" >&2

RELEASE_SOURCE_DIR="${staging}/payload" \
  "${SERVER_SCRIPTS}/upload-release.sh" "${staging}/payload/manifest.json"
