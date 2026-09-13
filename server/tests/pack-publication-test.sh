#!/usr/bin/env bash

# The client pack is part of publication, not of one caller (ADR-0013): every
# publisher produces one, an already-published release with no pack gets it
# filled, and a game whose clients sync from the server gets none.

set -Eeuo pipefail

REPOSITORY_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPTS="${REPOSITORY_ROOT}/server/scripts"
fixture="$(mktemp -d /tmp/spawnpoint-pack-test.XXXXXXXX)"
cleanup() {
  rm -rf -- "${fixture}"
}
trap cleanup EXIT

mkdir -p -- "${fixture}/bin"
ln -s -- "${REPOSITORY_ROOT}/server/tests/fake-aws" "${fixture}/bin/aws"
export PATH="${fixture}/bin:${PATH}"
export FAKE_S3_ROOT="${fixture}/fake-s3"
export RELEASE_BUCKET="spawnpoint-test-releases"
export RELEASE_PROFILE_ID="test-preset"
export RELEASE_PROFILE_REPOSITORY="https://github.com/example/config"
export RELEASE_PROFILE_COMMIT="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
release_root="${FAKE_S3_ROOT}/${RELEASE_BUCKET}"

# --- minecraft: publishing a release publishes its pack ---
mkdir -p -- "${fixture}/mc/mods"
printf 'jar one\n' >"${fixture}/mc/mods/alpha-1.0.jar"
printf 'jar two\n' >"${fixture}/mc/mods/beta-2.0.jar"
"${SCRIPTS}/build-release-manifest.sh" 7.0 1.20.1 47.4.10 \
  "${fixture}/mc/mods" "${fixture}/mc/manifest.json" >/dev/null
output="$(RELEASE_SOURCE_DIR="${fixture}/mc" "${SCRIPTS}/upload-release.sh" "${fixture}/mc/manifest.json")"
grep -qx 'pack=uploaded' <<<"${output}"
grep -qx 'pack_key=releases/minecraft/test-preset/7.0/client.zip' <<<"${output}"

pack="${release_root}/releases/minecraft/test-preset/7.0/client.zip"
[[ -f "${pack}" ]]
listing="$(unzip -l "${pack}")"
grep -q 'alpha-1.0.jar' <<<"${listing}"
grep -q 'beta-2.0.jar' <<<"${listing}"
grep -q 'INSTALL.txt' <<<"${listing}"
unzip -p "${pack}" INSTALL.txt | grep -q 'Minecraft 1.20.1, forge 47.4.10'
unzip -p "${pack}" INSTALL.txt | grep -qi 'delete your mods folder ENTIRELY'

# republishing is idempotent and leaves the pack alone: zips are not
# byte-reproducible, so existence is the test
repeat="$(RELEASE_SOURCE_DIR="${fixture}/mc" "${SCRIPTS}/upload-release.sh" "${fixture}/mc/manifest.json")"
grep -qx 'result=already_present' <<<"${repeat}"
grep -qx 'pack=already_present' <<<"${repeat}"

# --- the gap release 1.1 fell into: a published release whose pack is missing
#     is filled by republishing, which is what scripts/publish-pack.sh does ---
rm -- "${pack}"
backfill="$(RELEASE_SOURCE_DIR="${fixture}/mc" "${SCRIPTS}/upload-release.sh" "${fixture}/mc/manifest.json")"
grep -qx 'result=already_present' <<<"${backfill}"
grep -qx 'pack=uploaded' <<<"${backfill}"
[[ -f "${pack}" ]]

# --- factorio: the sync from the server covers the common case, but a client
#     that cannot reach the portal still needs the exact files ---
mkdir -p -- "${fixture}/factorio/mods"
printf 'zip bytes\n' >"${fixture}/factorio/mods/alien-biomes_0.6.8.zip"
RELEASE_GAME=factorio \
RELEASE_RUNTIME_IMAGE=registry.example.invalid/factorio:9.9.9@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
  "${SCRIPTS}/build-release-manifest.sh" 7.1 2.0.77 2.0.77 \
  "${fixture}/factorio/mods" "${fixture}/factorio/manifest.json" >/dev/null
factorio_output="$(
  RELEASE_SOURCE_DIR="${fixture}/factorio" "${SCRIPTS}/upload-release.sh" "${fixture}/factorio/manifest.json"
)"
grep -qx 'pack=uploaded' <<<"${factorio_output}"
factorio_pack="${release_root}/releases/factorio/test-preset/7.1/client.zip"
[[ -f "${factorio_pack}" ]]
grep -q 'alien-biomes_0.6.8.zip' <<<"$(unzip -l "${factorio_pack}")"
factorio_notes="$(unzip -p "${factorio_pack}" INSTALL.txt)"
grep -q 'Factorio 2.0.77' <<<"${factorio_notes}"
grep -q 'mods folder' <<<"${factorio_notes}"
# the minecraft instruction must not leak into another game's notes
! grep -qi 'delete your mods folder ENTIRELY' <<<"${factorio_notes}"

# --- a missing zip refuses before anything is published: the alternative is a
#     complete release with no pack and a red build, which is how the gap
#     appeared in the first place ---
nozip="${fixture}/nozip-bin"
mkdir -p -- "${nozip}"
for binary in /usr/bin/* /bin/*; do
  name="$(basename -- "${binary}")"
  [[ "${name}" != "zip" ]] || continue
  ln -sf -- "${binary}" "${nozip}/${name}"
done
ln -sf -- "${REPOSITORY_ROOT}/server/tests/fake-aws" "${nozip}/aws"

mkdir -p -- "${fixture}/late/mods"
printf 'jar\n' >"${fixture}/late/mods/gamma-1.0.jar"
"${SCRIPTS}/build-release-manifest.sh" 7.2 1.20.1 47.4.10 \
  "${fixture}/late/mods" "${fixture}/late/manifest.json" >/dev/null
if nozip_output="$(
  env PATH="${nozip}" FAKE_S3_ROOT="${FAKE_S3_ROOT}" RELEASE_BUCKET="${RELEASE_BUCKET}" \
    RELEASE_SOURCE_DIR="${fixture}/late" \
    "${SCRIPTS}/upload-release.sh" "${fixture}/late/manifest.json" 2>&1
)"; then
  printf 'expected failure: publishing a minecraft release without zip\n' >&2
  exit 1
fi
grep -q 'zip' <<<"${nozip_output}"
[[ ! -e "${release_root}/releases/minecraft/test-preset/7.2/manifest.json" ]]
[[ ! -e "${release_root}/releases/minecraft/test-preset/7.2/mods/gamma-1.0.jar" ]]

printf 'pack-publication-test: ok\n'
