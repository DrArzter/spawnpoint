#!/usr/bin/env bash

set -Eeuo pipefail

repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
scripts="${repository_root}/server/scripts"
fixture="$(mktemp -d /tmp/spawnpoint-release-overrides-test.XXXXXXXX)"
cleanup() {
  rm -rf -- "${fixture}"
}
trap cleanup EXIT

mkdir -p -- "${fixture}/payload/mods" "${fixture}/payload/overrides/config/pack" \
  "${fixture}/payload/overrides/kubejs/server_scripts" "${fixture}/client" "${fixture}/bin"
printf 'fabric jar\n' >"${fixture}/payload/mods/example.jar"
for index in {1..9}; do
  printf 'additional mod %s\n' "${index}" >"${fixture}/payload/mods/extra-${index}.jar"
done
printf 'pack config\n' >"${fixture}/payload/overrides/config/pack/server.json"
printf 'recipe\n' >"${fixture}/payload/overrides/kubejs/server_scripts/recipe.js"
printf 'launcher manifest\n' >"${fixture}/client/manifest.json"
(cd "${fixture}/client" && zip -qr "${fixture}/payload/client.zip" .)

manifest="${fixture}/payload/manifest.json"
RELEASE_GAME=minecraft \
RELEASE_LOADER_TYPE=fabric \
RELEASE_PROFILE_ID=prominence \
RELEASE_PROFILE_REPOSITORY=https://github.com/example/config \
RELEASE_PROFILE_COMMIT=0123456789abcdef0123456789abcdef01234567 \
RELEASE_SERVER_OVERRIDES_DIR="${fixture}/payload/overrides" \
RELEASE_CLIENT_PACK="${fixture}/payload/client.zip" \
  "${scripts}/build-release-manifest.sh" \
    4.1 1.20.1 0.19.3 "${fixture}/payload/mods" "${manifest}" >/dev/null

jq -e '
  .loader == {type: "fabric", version: "0.19.3"} and
  (.server.mods | length) == 10 and
  (.server.overrides | length) == 2 and
  .client.kind == "curseforge-modpack" and
  .client.file == "client.zip"
' "${manifest}" >/dev/null

ln -s -- "${repository_root}/server/tests/fake-aws" "${fixture}/bin/aws"
export PATH="${fixture}/bin:${PATH}"
export FAKE_S3_ROOT="${fixture}/s3"
export RELEASE_BUCKET=spawnpoint-test-releases
RELEASE_SOURCE_DIR="${fixture}/payload" "${scripts}/upload-release.sh" "${manifest}" >/dev/null

release_root="${FAKE_S3_ROOT}/${RELEASE_BUCKET}/releases/minecraft/prominence/4.1"
cmp -- "${fixture}/payload/overrides/config/pack/server.json" \
  "${release_root}/overrides/config/pack/server.json"
cmp -- "${fixture}/payload/client.zip" "${release_root}/client.zip"

# Failure in a parallel batch must never commit a complete release marker.
if FAKE_S3_ROOT="${fixture}/failed-s3" \
  FAKE_S3_PUT_FAIL_KEY=releases/minecraft/prominence/4.1/overrides/config/pack/server.json \
  RELEASE_SOURCE_DIR="${fixture}/payload" "${scripts}/upload-release.sh" "${manifest}" >/dev/null 2>&1; then
  printf 'expected failed payload upload to refuse publication\n' >&2
  exit 1
fi
[[ ! -e "${fixture}/failed-s3/${RELEASE_BUCKET}/releases/minecraft/prominence/4.1/manifest.json" ]]
[[ ! -e "${fixture}/failed-s3/${RELEASE_BUCKET}/releases/minecraft/prominence/4.1/client.zip" ]]

"${scripts}/download-release.sh" minecraft prominence 4.1 "${fixture}/cache" >/dev/null
cmp -- "${fixture}/payload/overrides/kubejs/server_scripts/recipe.js" \
  "${fixture}/cache/overrides/kubejs/server_scripts/recipe.js"

mkdir -p -- "${fixture}/world/data/config/pack" "${fixture}/world/data/operator"
printf 'old config\n' >"${fixture}/world/data/config/pack/old.json"
printf 'keep me\n' >"${fixture}/world/data/operator/notes.txt"
"${scripts}/reconcile-server-overrides.sh" "${fixture}/cache/manifest.json" "${fixture}/world/data" >/dev/null
[[ ! -e "${fixture}/world/data/config/pack/old.json" ]]
cmp -- "${fixture}/payload/overrides/config/pack/server.json" \
  "${fixture}/world/data/config/pack/server.json"
cmp -- "${fixture}/payload/overrides/kubejs/server_scripts/recipe.js" \
  "${fixture}/world/data/kubejs/server_scripts/recipe.js"
grep -Fxq 'keep me' "${fixture}/world/data/operator/notes.txt"
jq -e '.release == "4.1" and .roots == ["config", "kubejs"]' \
  "${fixture}/world/data/.spawnpoint-overrides.json" >/dev/null

printf 'tampered\n' >>"${fixture}/cache/overrides/config/pack/server.json"
if "${scripts}/reconcile-server-overrides.sh" "${fixture}/cache/manifest.json" "${fixture}/world/data" >/dev/null 2>&1; then
  printf 'expected tampered override to be rejected\n' >&2
  exit 1
fi
grep -Fxq 'pack config' "${fixture}/world/data/config/pack/server.json"

printf 'result=passed\n'
