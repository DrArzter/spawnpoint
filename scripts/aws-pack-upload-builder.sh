#!/usr/bin/env bash

# CodeBuild entrypoint for publishing a release from an uploaded pack.
#
# The upload path exists because a pack is hundreds of megabytes: too large for
# a bot to fetch (Telegram lets a bot download 20 MB) and too large to unzip in
# a Lambda. The panel presigns a PUT into the releases bucket, and this runs
# afterwards with nothing but the object key.
#
# The archive is the only untrusted input, and it is never trusted: extraction
# happens through extract-pack-upload.sh, which validates every entry name
# before writing anything.

set -Eeuo pipefail

REPOSITORY_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
SERVER_SCRIPTS="${REPOSITORY_ROOT}/server/scripts"

for variable in UPLOAD_KEY RELEASE RELEASE_BUCKET GAME_VERSION LOADER_VERSION; do
  [[ -n "${!variable:-}" && "${!variable}" != "REQUIRED_BY_CALLER" ]] || {
    printf 'error: %s is required\n' "${variable}" >&2
    exit 1
  }
done

release_game="${RELEASE_GAME:-minecraft}"
[[ "${RELEASE}" =~ ^[0-9]+\.[0-9]+$ ]] || {
  printf 'error: RELEASE must use MAJOR.MINOR: %s\n' "${RELEASE}" >&2
  exit 1
}
# The key is composed by the API, but this is the process that reads the object,
# so it checks the shape rather than assuming a well-behaved caller.
[[ "${UPLOAD_KEY}" =~ ^uploads/[0-9a-f-]{36}\.zip$ ]] || {
  printf 'error: refusing an upload key outside uploads/<uuid>.zip: %s\n' "${UPLOAD_KEY}" >&2
  exit 1
}

for command in aws jq sha256sum unzip; do
  command -v "${command}" >/dev/null 2>&1 || {
    printf 'error: required command not found: %s\n' "${command}" >&2
    exit 1
  }
done

workspace="$(mktemp -d /tmp/spawnpoint-pack-upload.XXXXXXXX)"
cleanup() {
  rm -rf -- "${workspace}"
}
trap cleanup EXIT

archive="${workspace}/pack.zip"
aws --region "${AWS_REGION:-eu-central-1}" --no-cli-pager s3api get-object \
  --bucket "${RELEASE_BUCKET}" \
  --key "${UPLOAD_KEY}" \
  "${archive}" >/dev/null || {
  printf 'error: could not read the uploaded pack: s3://%s/%s\n' "${RELEASE_BUCKET}" "${UPLOAD_KEY}" >&2
  exit 1
}

payload="${workspace}/payload"
extract_output="$(
  PACK_MOD_EXTENSION="$(case "${release_game}" in factorio) printf 'zip' ;; *) printf 'jar' ;; esac)" \
    "${SERVER_SCRIPTS}/extract-pack-upload.sh" "${archive}" "${payload}/mods"
)"
mods="$(awk -F= '$1 == "mods" { print $2 }' <<<"${extract_output}")"

RELEASE_GAME="${release_game}" \
RELEASE_CREATED_BY="${RELEASE_CREATED_BY:-panel-upload}" \
RELEASE_CHANGELOG="${RELEASE_CHANGELOG:-Uploaded pack, ${mods} files}" \
  "${SERVER_SCRIPTS}/build-release-manifest.sh" \
    "${RELEASE}" "${GAME_VERSION}" "${LOADER_VERSION}" "${payload}/mods" "${payload}/manifest.json" >/dev/null

RELEASE_SOURCE_DIR="${payload}" \
  "${SERVER_SCRIPTS}/upload-release.sh" "${payload}/manifest.json"

# The upload is consumed: leaving it would keep a second copy of every pack in
# the bucket, and the release itself is now the durable artefact.
aws --region "${AWS_REGION:-eu-central-1}" --no-cli-pager s3api delete-object \
  --bucket "${RELEASE_BUCKET}" \
  --key "${UPLOAD_KEY}" >/dev/null || {
  printf 'warning: the release is published but the upload was not removed: %s\n' "${UPLOAD_KEY}" >&2
}

printf 'result=release_ready\n'
printf 'release=%s\n' "${RELEASE}"
printf 'game=%s\n' "${release_game}"
printf 'mods=%s\n' "${mods}"
printf 'manifest_key=releases/%s/manifest.json\n' "${RELEASE}"
