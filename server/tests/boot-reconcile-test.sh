#!/usr/bin/env bash

# The boot-time reconciliation chain (ADR-0030): read the world's pointer,
# ensure a verified local copy of the desired release, reconcile the live mod
# directory against it. Exercised exactly as start-session.sh composes it,
# against the same fake S3 the import test populates.

set -Eeuo pipefail

REPOSITORY_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPTS="${REPOSITORY_ROOT}/server/scripts"
fixture="$(mktemp -d /tmp/spawnpoint-boot-reconcile-test.XXXXXXXX)"
cleanup() {
  rm -rf -- "${fixture}"
}
trap cleanup EXIT

expect_failure() {
  local label="$1"
  shift
  if "$@" >/dev/null 2>&1; then
    printf 'expected failure: %s\n' "${label}" >&2
    exit 1
  fi
}

mkdir -p -- "${fixture}/bin"
ln -s -- "${REPOSITORY_ROOT}/server/tests/fake-aws" "${fixture}/bin/aws"
ln -s -- "${REPOSITORY_ROOT}/server/tests/fake-node" "${fixture}/bin/node"
export FAKE_NODE_LOG="${fixture}/node.log"
export PATH="${fixture}/bin:${PATH}"
export FAKE_S3_ROOT="${fixture}/fake-s3"
export BACKUP_BUCKET="spawnpoint-test-backups"
export RELEASE_BUCKET="spawnpoint-test-releases"
export RELEASE_PROFILE_ID="main"
export RELEASE_PROFILE_REPOSITORY="https://github.com/example/config"
export RELEASE_PROFILE_COMMIT="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

# --- a world arrives the way worlds arrive: through import ---
mkdir -p -- "${fixture}/source/data/world" "${fixture}/source/pack/mods"
printf 'level fixture\n' >"${fixture}/source/data/world/level.dat"
printf 'jar one\n' >"${fixture}/source/pack/mods/alpha.jar"
printf 'jar two\n' >"${fixture}/source/pack/mods/beta.jar"
"${REPOSITORY_ROOT}/scripts/import-world.sh" \
  "${fixture}/source/data" world "${fixture}/source/pack/mods" 1.0 1.20.1 47.4.0 >/dev/null

# --- a fresh host: empty server dir, nothing cached ---
host="${fixture}/host"
mkdir -p -- "${host}"

# The import fixture still models the historical ingestion path. Move its
# pointer to the generation-scoped contract before exercising modern boot.
generation_id="gen-123456781234123412341234567890ab"
legacy_pointer="${FAKE_S3_ROOT}/${RELEASE_BUCKET}/worlds/world/release.json"
state_dir="${FAKE_S3_ROOT}/${RELEASE_BUCKET}/worlds/world/generations/${generation_id}"
mkdir -p -- "${state_dir}"
jq --arg generation "${generation_id}" '
  .schema_version = 2 |
  .world_id = .world |
  .generation_id = $generation |
  del(.world)
' "${legacy_pointer}" >"${state_dir}/release.json"

# 1. The release state answers for one exact wipe.
pointer_output="$("${SCRIPTS}/read-release-pointer.sh" world "${generation_id}")"
grep -qx 'desired_release=1.0' <<<"${pointer_output}"
grep -qx 'active_release=null' <<<"${pointer_output}"

# A world that was never imported is exit 3 — a state, not an error.
set +e
"${SCRIPTS}/read-release-pointer.sh" ghost "${generation_id}" >/dev/null 2>&1
[[ $? -eq 3 ]] || {
  printf 'expected exit 3 for an absent pointer\n' >&2
  exit 1
}
set -e

# 2. First download fetches everything in one copy; the payload is complete
# and verified, and the player packs beside it stay in the bucket.
release_root="${FAKE_S3_ROOT}/${RELEASE_BUCKET}/releases/minecraft/main/1.0"
for pack in client.zip server.zip full.zip; do
  printf 'pack bytes\n' >"${release_root}/${pack}"
done
calls="${fixture}/aws-calls"
download_output="$(FAKE_AWS_CALL_LOG="${calls}" \
  "${SCRIPTS}/download-release.sh" minecraft main 1.0 "${host}/releases/minecraft/main/1.0")"
grep -qx 'downloaded=2' <<<"${download_output}"
grep -qx 'kept=0' <<<"${download_output}"
cmp -- "${fixture}/source/pack/mods/alpha.jar" "${host}/releases/minecraft/main/1.0/mods/alpha.jar"
[[ "$(grep -c '^s3 cp ' "${calls}")" == "1" ]]
if grep -q 'get-object.*/mods/' "${calls}"; then
  printf 'expected no per-object fetch of a mod\n' >&2
  exit 1
fi
for pack in client.zip server.zip full.zip; do
  [[ ! -e "${host}/releases/minecraft/main/1.0/${pack}" ]]
done
[[ -z "$(find "${host}/releases/minecraft/main/1.0" -name '.fetch.*')" ]]

# 3. Reconcile materialises the live mod directory from the payload.
SERVER_PROJECT_DIRECTORY="${host}" \
  "${SCRIPTS}/reconcile-release.sh" "${host}/releases/minecraft/main/1.0/manifest.json" >/dev/null
cmp -- "${fixture}/source/pack/mods/beta.jar" "${host}/mods/beta.jar"
[[ -f "${host}/mods/.spawnpoint-release.json" ]]

# --- the boring boot: nothing changed, nothing downloads ---
second_output="$("${SCRIPTS}/download-release.sh" minecraft main 1.0 "${host}/releases/minecraft/main/1.0")"
grep -qx 'downloaded=0' <<<"${second_output}"
grep -qx 'kept=2' <<<"${second_output}"

# --- a killed start leaves temporary files; the next download removes them ---
payload="${host}/releases/minecraft/main/1.0"
mkdir -p -- "${payload}/.fetch.stale/mods"
printf 'half a release\n' >"${payload}/.fetch.stale/mods/alpha.jar"
printf 'half a link\n' >"${payload}/mods/.reuse.stale"
printf '{}\n' >"${payload}/.manifest.stale"
"${SCRIPTS}/download-release.sh" minecraft main 1.0 "${payload}" >/dev/null
[[ ! -e "${payload}/.fetch.stale" && ! -e "${payload}/mods/.reuse.stale" && ! -e "${payload}/.manifest.stale" ]]

# --- a second download of the same release waits for the first ---
lock="${host}/releases/minecraft/main/.1.0.download.lock"
exec 8>"${lock}"
flock 8
expect_failure "a download while another holds the release lock" \
  env DOWNLOAD_LOCK_WAIT_SECONDS=0 "${SCRIPTS}/download-release.sh" minecraft main 1.0 "${payload}"
exec 8>&-

# --- self-healing: a tampered cache entry is refetched, not trusted ---
printf 'corrupted\n' >>"${host}/releases/minecraft/main/1.0/mods/alpha.jar"
heal_output="$("${SCRIPTS}/download-release.sh" minecraft main 1.0 "${host}/releases/minecraft/main/1.0")"
grep -qx 'downloaded=1' <<<"${heal_output}"
grep -qx 'kept=1' <<<"${heal_output}"
cmp -- "${fixture}/source/pack/mods/alpha.jar" "${host}/releases/minecraft/main/1.0/mods/alpha.jar"

# --- refusals ---
expect_failure "an unpublished release" \
  "${SCRIPTS}/download-release.sh" minecraft main 9.9 "${host}/releases/minecraft/main/9.9"

corrupt="${FAKE_S3_ROOT}/${RELEASE_BUCKET}/releases/minecraft/main/1.0/mods/beta.jar"
printf 'evil bytes\n' >"${corrupt}"
rm -rf -- "${host}/releases/minecraft/main/1.0/mods/beta.jar"
expect_failure "a bucket object that does not match the manifest" \
  "${SCRIPTS}/download-release.sh" minecraft main 1.0 "${host}/releases/minecraft/main/1.0"

# --- reuse: a file another cached release holds is linked, not fetched ---
next_root="${FAKE_S3_ROOT}/${RELEASE_BUCKET}/releases/minecraft/main/1.1"
mkdir -p -- "${next_root}/mods"
cp -- "${release_root}/mods/alpha.jar" "${next_root}/mods/alpha.jar"
printf 'jar three\n' >"${next_root}/mods/gamma.jar"
gamma_sha="$(sha256sum -- "${next_root}/mods/gamma.jar")"
jq --arg sha "${gamma_sha%% *}" '
  .release = "1.1" |
  .server.mods = [(.server.mods[] | select(.file == "alpha.jar")),
    {file: "gamma.jar", sha256: $sha, bytes: 10}]
' "${release_root}/manifest.json" >"${next_root}/manifest.json"
: >"${calls}"
reuse_output="$(FAKE_AWS_CALL_LOG="${calls}" \
  "${SCRIPTS}/download-release.sh" minecraft main 1.1 "${host}/releases/minecraft/main/1.1")"
grep -qx 'downloaded=1' <<<"${reuse_output}"
grep -qx 'reused=1' <<<"${reuse_output}"
[[ "${host}/releases/minecraft/main/1.1/mods/alpha.jar" -ef "${host}/releases/minecraft/main/1.0/mods/alpha.jar" ]]
grep -q -- '--include mods/gamma.jar' "${calls}"
if grep -q -- 'alpha.jar' "${calls}"; then
  printf 'expected the cached alpha.jar to be reused, not fetched\n' >&2
  exit 1
fi

# A cached copy that no longer matches its hash is not reused.
rm -rf -- "${host}/releases/minecraft/main/1.1"
printf 'corrupted\n' >>"${host}/releases/minecraft/main/1.0/mods/alpha.jar"
fallback_output="$("${SCRIPTS}/download-release.sh" minecraft main 1.1 "${host}/releases/minecraft/main/1.1")"
grep -qx 'downloaded=2' <<<"${fallback_output}"
grep -qx 'reused=0' <<<"${fallback_output}"
cmp -- "${fixture}/source/pack/mods/alpha.jar" "${host}/releases/minecraft/main/1.1/mods/alpha.jar"

printf 'boot-reconcile-test: ok\n'
