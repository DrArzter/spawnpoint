#!/usr/bin/env bash

# A release with many small override files must upload in a bounded sliding
# window, confirm each object from the put-object response, stop at the first
# failure, and write the manifest last.

set -Eeuo pipefail

repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
scripts="${repository_root}/server/scripts"
fixture="$(mktemp -d /tmp/spawnpoint-upload-window-test.XXXXXXXX)"
cleanup() {
  rm -rf -- "${fixture}"
}
trap cleanup EXIT

overrides_total=120
mkdir -p -- "${fixture}/payload/mods" "${fixture}/payload/overrides/config" "${fixture}/bin" "${fixture}/inflight"
printf 'jar\n' >"${fixture}/payload/mods/example.jar"
for index in $(seq -w 1 "${overrides_total}"); do
  printf 'config %s\n' "${index}" >"${fixture}/payload/overrides/config/f${index}.json"
done
manifest="${fixture}/payload/manifest.json"
RELEASE_GAME=minecraft \
RELEASE_LOADER_TYPE=fabric \
RELEASE_PROFILE_ID=window \
RELEASE_PROFILE_REPOSITORY=https://github.com/example/config \
RELEASE_PROFILE_COMMIT=0123456789abcdef0123456789abcdef01234567 \
RELEASE_SERVER_OVERRIDES_DIR="${fixture}/payload/overrides" \
  "${scripts}/build-release-manifest.sh" 1.0 1.20.1 0.19.3 "${fixture}/payload/mods" "${manifest}" >/dev/null
[[ "$(jq '.server.overrides | length' "${manifest}")" == "${overrides_total}" ]]

ln -s -- "${repository_root}/server/tests/fake-aws" "${fixture}/bin/aws"
export PATH="${fixture}/bin:${PATH}"
export RELEASE_BUCKET=spawnpoint-test-releases
export RELEASE_SOURCE_DIR="${fixture}/payload"
export RELEASE_UPLOAD_CONCURRENCY=6
export RELEASE_UPLOAD_PROGRESS_EVERY=20
prefix=releases/minecraft/window/1.0

# Success: bounded window, no head-object per payload object, manifest last.
export FAKE_S3_ROOT="${fixture}/s3"
export FAKE_AWS_CALL_LOG="${fixture}/calls"
export FAKE_S3_INFLIGHT_DIR="${fixture}/inflight"
export FAKE_S3_INFLIGHT_LOG="${fixture}/inflight.log"
export FAKE_S3_PUT_SLEEP=0.3
"${scripts}/upload-release.sh" "${manifest}" >/dev/null 2>"${fixture}/stderr"

peak="$(sort -n "${fixture}/inflight.log" | tail -n 1)"
(( peak <= RELEASE_UPLOAD_CONCURRENCY )) || { printf 'window exceeded: %s\n' "${peak}" >&2; exit 1; }
(( peak >= RELEASE_UPLOAD_CONCURRENCY - 1 )) || { printf 'window not used: %s\n' "${peak}" >&2; exit 1; }

overrides_heads="$(grep -c "head-object .*--key ${prefix}/overrides/" "${fixture}/calls" || true)"
[[ "${overrides_heads}" == 0 ]]
overrides_puts="$(grep -c "put-object .*--key ${prefix}/overrides/" "${fixture}/calls")"
[[ "${overrides_puts}" == "${overrides_total}" ]]

last_put="$(grep 'put-object' "${fixture}/calls" | tail -n 1)"
[[ "${last_put}" == *"--key ${prefix}/manifest.json "* ]]
grep -q -- "--key ${prefix}/client.zip " "${fixture}/calls"
grep -q 'uploaded 20 objects in' "${fixture}/stderr"
grep -q 'payload upload finished: 121 objects in' "${fixture}/stderr"
grep -q 'release published in' "${fixture}/stderr"
cmp -- "${fixture}/payload/overrides/config/f007.json" "${FAKE_S3_ROOT}/${RELEASE_BUCKET}/${prefix}/overrides/config/f007.json"

# A response that does not echo the digest stops publication and names the key.
export FAKE_S3_ROOT="${fixture}/bad-s3"
if FAKE_S3_PUT_BAD_RESPONSE_KEY="${prefix}/overrides/config/f010.json" \
  "${scripts}/upload-release.sh" "${manifest}" >/dev/null 2>"${fixture}/bad-stderr"; then
  printf 'expected an unconfirmed upload to refuse publication\n' >&2
  exit 1
fi
grep -q "upload not confirmed by S3: s3://${RELEASE_BUCKET}/${prefix}/overrides/config/f010.json" "${fixture}/bad-stderr"
[[ ! -e "${FAKE_S3_ROOT}/${RELEASE_BUCKET}/${prefix}/manifest.json" ]]

# Fail fast: the first failed object stops queueing, names its key, and leaves
# no pack and no manifest. In-flight uploads are awaited, not abandoned.
export FAKE_S3_ROOT="${fixture}/failed-s3"
: >"${fixture}/calls"
if FAKE_S3_PUT_FAIL_KEY="${prefix}/overrides/config/f003.json" \
  "${scripts}/upload-release.sh" "${manifest}" >/dev/null 2>"${fixture}/fail-stderr"; then
  printf 'expected a failed upload to refuse publication\n' >&2
  exit 1
fi
grep -q "upload failed: s3://${RELEASE_BUCKET}/${prefix}/overrides/config/f003.json" "${fixture}/fail-stderr"
(( $(grep -c 'put-object' "${fixture}/calls") < overrides_total / 2 ))
[[ ! -e "${FAKE_S3_ROOT}/${RELEASE_BUCKET}/${prefix}/manifest.json" ]]
[[ ! -e "${FAKE_S3_ROOT}/${RELEASE_BUCKET}/${prefix}/client.zip" ]]
[[ -z "$(find "${fixture}/inflight" -type f)" ]]

printf 'upload-release-window-test: ok\n'
