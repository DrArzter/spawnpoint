#!/usr/bin/env bash

# The backup holder (ADR-0080): written once for a live release, refused for any
# other, and safe to repeat. The fake table is a JSON file.

set -Eeuo pipefail

repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
hold="${repository_root}/server/scripts/hold-backup-release.sh"
fixture="$(mktemp -d /tmp/spawnpoint-hold-backup-test.XXXXXXXX)"
cleanup() {
  rm -rf -- "${fixture}"
}
trap cleanup EXIT

mkdir -p -- "${fixture}/bin" "${fixture}/s3"
ln -s -- "${repository_root}/server/tests/fake-aws" "${fixture}/bin/aws"
export PATH="${fixture}/bin:${PATH}"
export FAKE_S3_ROOT="${fixture}/s3"
export FAKE_DDB_FILE="${fixture}/refs.json"
export AWS_REGION=eu-central-1
printf '%s' '{"release#minecraft/industrial/1.2|meta":{"state":{"S":"live"},"holders":{"N":"4"}},"release#minecraft/industrial/1.3|meta":{"state":{"S":"retired"},"holders":{"N":"0"}}}' >"${FAKE_DDB_FILE}"

key="worlds/alpha/archives/alpha-gen-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-20261122T000000Z-cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc.tar.zst"
slot="release#minecraft/industrial/1.2|hold#backup#${key}#v1"

[[ "$("${hold}" minecraft industrial 1.2 "${key}" v1)" == "result=held" ]]
[[ "$(jq -r --arg slot "${slot}" '.[$slot].roles.SS | join(",")' "${FAKE_DDB_FILE}")" == "backup" ]]
[[ "$(jq -r '."release#minecraft/industrial/1.2|meta".holders.N' "${FAKE_DDB_FILE}")" == "5" ]]

# A second run writes nothing: the count stays.
[[ "$("${hold}" minecraft industrial 1.2 "${key}" v1)" == "result=already_held" ]]
[[ "$(jq -r '."release#minecraft/industrial/1.2|meta".holders.N' "${FAKE_DDB_FILE}")" == "5" ]]

# Another version of the same key is another holder.
[[ "$("${hold}" minecraft industrial 1.2 "${key}" v2)" == "result=held" ]]

# A release that is not live, or not registered, is refused and nothing changes.
before="$(cat -- "${FAKE_DDB_FILE}")"
for release in 1.3 9.9; do
  code=0
  "${hold}" minecraft industrial "${release}" "${key}" v1 2>"${fixture}/refused.err" || code=$?
  (( code != 0 ))
  grep -q 'was not written' "${fixture}/refused.err"
done
grep -q 'is retired' "${fixture}/refused.err" || grep -q 'not registered' "${fixture}/refused.err"
[[ "$(cat -- "${FAKE_DDB_FILE}")" == "${before}" ]]

# A table that cannot be reached fails the call; the caller decides what that means.
code=0
FAKE_DDB_FAIL=true "${hold}" minecraft industrial 1.2 "${key}" v3 2>/dev/null || code=$?
(( code != 0 ))

# Unsafe input is refused before any call.
for bad in "../x" "bad key"; do
  code=0
  "${hold}" minecraft industrial 1.2 "${bad}" v1 2>/dev/null || code=$?
  (( code != 0 ))
done

printf 'hold-backup-release-test: ok\n'
