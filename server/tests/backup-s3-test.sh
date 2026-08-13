#!/usr/bin/env bash

set -Eeuo pipefail

REPOSITORY_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
fixture="$(mktemp -d /tmp/spawnpoint-backup-s3-test.XXXXXXXX)"
cleanup() {
  rm -rf -- "${fixture}"
}
trap cleanup EXIT

mkdir -p -- "${fixture}/data/world/region" "${fixture}/backups" "${fixture}/fake-s3" "${fixture}/bin"
ln -s -- "${REPOSITORY_ROOT}/server/tests/fake-aws" "${fixture}/bin/aws"
printf 'level fixture\n' >"${fixture}/data/world/level.dat"
printf 'region fixture\n' >"${fixture}/data/world/region/r.0.0.mca"

archive_output="$(
  SERVER_DATA_DIR="${fixture}/data" \
  SERVER_BACKUP_DIR="${fixture}/backups" \
  WORLD_NAME=world \
    "${REPOSITORY_ROOT}/server/scripts/archive-world.sh"
)"
archive="$(awk -F= '$1 == "archive" { print $2 }' <<<"${archive_output}")"

export PATH="${fixture}/bin:${PATH}"
export FAKE_S3_ROOT="${fixture}/fake-s3"
export BACKUP_BUCKET="spawnpoint-test-backups"
export WORLD_NAME=world

upload_output="$("${REPOSITORY_ROOT}/server/scripts/upload-world-backup.sh" "${archive}")"
grep -qx 'result=uploaded' <<<"${upload_output}"
object_key="$(awk -F= '$1 == "object_key" { print $2 }' <<<"${upload_output}")"
[[ -n "${object_key}" ]]

repeat_output="$("${REPOSITORY_ROOT}/server/scripts/upload-world-backup.sh" "${archive}")"
grep -qx 'result=already_present' <<<"${repeat_output}"

download="${fixture}/download/world-restored.tar.zst"
download_output="$("${REPOSITORY_ROOT}/server/scripts/download-world-backup.sh" "${object_key}" "${download}")"
grep -qx 'result=downloaded_and_verified' <<<"${download_output}"
cmp -- "${archive}" "${download}"

metadata_file="${fixture}/fake-s3/${BACKUP_BUCKET}/${object_key}.fake-metadata"
sed -i -E '1s/^sha256=[0-9a-f]{64}/sha256=0000000000000000000000000000000000000000000000000000000000000000/' "${metadata_file}"
if "${REPOSITORY_ROOT}/server/scripts/download-world-backup.sh" "${object_key}" "${fixture}/corrupt.tar.zst" >/dev/null 2>&1; then
  printf 'expected corrupt metadata download to fail\n' >&2
  exit 1
fi
[[ ! -e "${fixture}/corrupt.tar.zst" ]]

printf 'result=passed\n'
printf 'object_key=%s\n' "${object_key}"
