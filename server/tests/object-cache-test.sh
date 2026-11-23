#!/usr/bin/env bash

# Host readers of content-addressed releases (storage layout objects-v1): the
# shared object cache, the download, hard-linked staging, the start-time check,
# eviction, and an old host meeting a new release. Fixture manifests only; the
# builder does not write objects-v1 yet.

set -Eeuo pipefail

REPOSITORY_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPTS="${REPOSITORY_ROOT}/server/scripts"
fixture="$(mktemp -d /tmp/spawnpoint-object-cache-test.XXXXXXXX)"
trap 'rm -rf -- "${fixture}"' EXIT

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}
expect_failure() {
  local label="$1"
  shift
  if "$@" >/dev/null 2>&1; then
    fail "expected failure: ${label}"
  fi
}
# Run a command that must fail and keep its stderr in ${fixture}/err.
fails_with() {
  local needle="$1"
  shift
  if "$@" >"${fixture}/out" 2>"${fixture}/err"; then
    fail "expected failure containing '${needle}'"
  fi
  grep -Fq -- "${needle}" "${fixture}/err" || {
    cat "${fixture}/err" >&2
    fail "error does not contain '${needle}'"
  }
}
inode() {
  local path="$1"
  stat --format '%i' -- "${path}"
}
links() {
  local path="$1"
  stat --format '%h' -- "${path}"
}
sha() {
  local file="$1" out
  out="$(sha256sum -- "${file}")"
  printf '%s' "${out%% *}"
}

mkdir -p -- "${fixture}/bin"
ln -s -- "${REPOSITORY_ROOT}/server/tests/fake-aws" "${fixture}/bin/aws"
export PATH="${fixture}/bin:${PATH}"
export FAKE_S3_ROOT="${fixture}/s3"
export RELEASE_BUCKET="spawnpoint-test-releases"
host="${fixture}/host"
export SERVER_PROJECT_DIRECTORY="${host}"
unset OBJECT_CACHE_DIR OBJECT_CACHE_START_CHECK OBJECT_CACHE_STAGE_MODE
bucket_root="${FAKE_S3_ROOT}/${RELEASE_BUCKET}"
cache="${host}/objects"
mkdir -p -- "${host}"

# --- fixture payload: two mods, two overrides ---
mkdir -p -- "${fixture}/src/mods" "${fixture}/src/overrides/config"
printf 'jar alpha bytes\n' >"${fixture}/src/mods/alpha.jar"
printf 'jar beta bytes!\n' >"${fixture}/src/mods/beta.jar"
printf 'a = 1\n' >"${fixture}/src/overrides/config/a.toml"
printf 'b = 22\n' >"${fixture}/src/overrides/config/b.toml"

object_path() { printf '%s/sha256/%s/%s' "${cache}" "${1:0:2}" "$1"; }
put_object() {
  local file="$1" digest
  digest="$(sha "${file}")"
  mkdir -p -- "${bucket_root}/objects/sha256/${digest:0:2}"
  cp -- "${file}" "${bucket_root}/objects/sha256/${digest:0:2}/${digest}"
  printf '%s' "${digest}"
}

alpha_sha="$(put_object "${fixture}/src/mods/alpha.jar")"
beta_sha="$(put_object "${fixture}/src/mods/beta.jar")"
cfg_a_sha="$(put_object "${fixture}/src/overrides/config/a.toml")"
cfg_b_sha="$(put_object "${fixture}/src/overrides/config/b.toml")"

# publish <release> <extra jq filter>: write an objects-v1 manifest.
publish() {
  local release="$1" filter="${2:-.}" dir
  dir="${bucket_root}/releases/minecraft/main/${release}"
  mkdir -p -- "${dir}"
  jq -n \
    --arg release "${release}" --arg alpha "${alpha_sha}" --arg beta "${beta_sha}" \
    --arg ca "${cfg_a_sha}" --arg cb "${cfg_b_sha}" \
    --argjson ab "$(stat --format '%s' "${fixture}/src/mods/alpha.jar")" \
    --argjson bb "$(stat --format '%s' "${fixture}/src/mods/beta.jar")" \
    --argjson cab "$(stat --format '%s' "${fixture}/src/overrides/config/a.toml")" \
    --argjson cbb "$(stat --format '%s' "${fixture}/src/overrides/config/b.toml")" '{
      schema_version: 1, game: "minecraft", release: $release,
      minecraft_version: "1.20.1", loader: {type: "forge", version: "47.4.0"},
      created_at: "2026-11-22T00:00:00Z", created_by: "test", changelog: "",
      source_profile: {id: "main", repository: "https://example.invalid/config", commit: ("a" * 40)},
      storage: {layout: "objects-v1"},
      server: {
        mods: [{file: "alpha.jar", sha256: $alpha, bytes: $ab}, {file: "beta.jar", sha256: $beta, bytes: $bb}],
        overrides: [{path: "config/a.toml", sha256: $ca, bytes: $cab}, {path: "config/b.toml", sha256: $cb, bytes: $cbb}]
      }
    }' | jq "${filter}" >"${dir}/manifest.json"
}
payload_of() { printf '%s/releases/minecraft/main/%s' "${host}" "$1"; }
download() {
  local release="$1"
  "${SCRIPTS}/download-release.sh" minecraft main "${release}" "$(payload_of "${release}")"
}
publish 1.0

# --- (a) a fresh host fetches only what is missing; a repeat fetches nothing ---
calls="${fixture}/calls"
: >"${calls}"
out="$(FAKE_AWS_CALL_LOG="${calls}" download 1.0)"
grep -qx 'layout=objects-v1' <<<"${out}" || fail "layout line: ${out}"
grep -qx 'fetched=4' <<<"${out}" || fail "first download: ${out}"
grep -qx 'result=release_ready' <<<"${out}"
# One exact copy per shard (the first two hex digits), never one over the
# whole store, which every release shares.
shards="$(printf '%s\n' "${alpha_sha:0:2}" "${beta_sha:0:2}" "${cfg_a_sha:0:2}" "${cfg_b_sha:0:2}" | sort -u)"
[[ "$(grep -c '^s3 cp ' "${calls}")" == "$(wc -l <<<"${shards}")" ]] || fail "expected one copy per shard"
while read -r shard; do
  grep -q "^s3 cp s3://${RELEASE_BUCKET}/objects/sha256/${shard}/ " "${calls}" || fail "no copy of shard ${shard}"
done <<<"${shards}"
if grep -q "^s3 cp s3://${RELEASE_BUCKET}/objects/sha256/ " "${calls}"; then
  fail "a copy listed the whole object store"
fi
grep -qF -- "--include ${alpha_sha}" "${calls}" || fail "the alpha object has no exact filter"
grep -qx 'fetch=shards' <<<"${out}" || fail "fetch line: ${out}"
grep -qx "shards=$(wc -l <<<"${shards}")" <<<"${out}" || fail "shards line: ${out}"
grep -qx "fetched_bytes=$(cat "${fixture}"/src/mods/*.jar "${fixture}"/src/overrides/config/*.toml | wc -c | tr -d ' ')" <<<"${out}" ||
  fail "fetched_bytes line: ${out}"
[[ -f "$(payload_of 1.0)/manifest.json" ]]
cmp -- "${fixture}/src/mods/alpha.jar" "$(payload_of 1.0)/mods/alpha.jar"
cmp -- "${fixture}/src/overrides/config/b.toml" "$(payload_of 1.0)/overrides/config/b.toml"
[[ -z "$(find "${cache}" -name '.fetch.*' -print -quit)" ]]
[[ -z "$(find "$(payload_of 1.0)" -name '.reuse.*' -print -quit)" ]]
for digest in "${alpha_sha}" "${beta_sha}" "${cfg_a_sha}" "${cfg_b_sha}"; do
  [[ "$(stat --format '%a %u' -- "$(object_path "${digest}")")" == "444 0" ]] || fail "cache file mode or owner"
done
[[ "$(stat --format '%a' -- "${cache}" "${cache}/sha256" "${cache}/sha256/${alpha_sha:0:2}" | sort -u)" == 755 ]]

: >"${calls}"
out="$(FAKE_AWS_CALL_LOG="${calls}" download 1.0)"
grep -qx 'fetched=0' <<<"${out}" || fail "second download: ${out}"
grep -qx 'kept=4' <<<"${out}" || fail "second download kept: ${out}"
[[ "$(grep -c '^s3 cp ' "${calls}")" == 0 ]] || fail "second download made a copy"
grep -qx 'fetch=none' <<<"${out}" || fail "second download fetch line: ${out}"

# A shard that cannot be copied fails the download after every shard ends,
# and none of the objects enters the cache unverified.
rm -rf -- "${cache}" "$(payload_of 1.0)"
fails_with "could not download the objects of release 1.0" env FAKE_S3_CP_FAIL_PREFIX="objects/sha256/${beta_sha:0:2}/" \
  RELEASE_DOWNLOAD_PARALLEL=1 "${SCRIPTS}/download-release.sh" minecraft main 1.0 "$(payload_of 1.0)"
[[ -z "$(find "${cache}" -name '.fetch.*' -print -quit)" ]] || fail "a failed copy left its fetch folder"
[[ ! -e "$(object_path "${beta_sha}")" ]] || fail "the failed shard reached the cache"
fails_with "RELEASE_DOWNLOAD_PARALLEL must be a whole number" env RELEASE_DOWNLOAD_PARALLEL=0 \
  "${SCRIPTS}/download-release.sh" minecraft main 1.0 "$(payload_of 1.0)"
fails_with "not enough disk space for release 1.0" env RELEASE_DOWNLOAD_DISK_MARGIN_BYTES=999999999999999999 \
  "${SCRIPTS}/download-release.sh" minecraft main 1.0 "$(payload_of 1.0)"
out="$(RELEASE_DOWNLOAD_PARALLEL=1 download 1.0)"
grep -qx 'fetched=4' <<<"${out}" || fail "one shard at a time: ${out}"

# A second release that shares the mods fetches only its new object.
printf 'jar gamma\n' >"${fixture}/src/mods/gamma.jar"
gamma_sha="$(put_object "${fixture}/src/mods/gamma.jar")"
publish 1.2 ".server.mods += [{file: \"gamma.jar\", sha256: \"${gamma_sha}\", bytes: 10}]"
out="$(download 1.2)"
grep -qx 'fetched=1' <<<"${out}" || fail "shared objects were fetched again: ${out}"
[[ "$(inode "$(payload_of 1.2)/mods/alpha.jar")" == "$(inode "$(object_path "${alpha_sha}")")" ]]

# --- the manifest's layout is checked ---
publish 1.3 '.storage.layout = "objects-v2"'
fails_with "does not know" download 1.3
fails_with "objects-v2" download 1.3
publish 1.3 '.storage.layout = 1'
fails_with "does not know" download 1.3
publish 1.3 '.storage = "x"'
fails_with "invalid manifest" download 1.3
[[ ! -e "$(payload_of 1.3)/manifest.json" ]]

# --- (b) a tampered cache file of the right size is refetched ---
alpha_object="$(object_path "${alpha_sha}")"
chmod 0644 -- "${alpha_object}"
printf 'jar alpha BYTES\n' >"${alpha_object}"
[[ "$(stat --format '%s' -- "${alpha_object}")" == "$(stat --format '%s' "${fixture}/src/mods/alpha.jar")" ]]
rm -f -- "$(payload_of 1.0)/mods/alpha.jar"
out="$(download 1.0 2>"${fixture}/err")"
grep -qx 'fetched=1' <<<"${out}" || fail "tampered object was not refetched: ${out}"
grep -Fq "${alpha_sha}" "${fixture}/err"
cmp -- "${fixture}/src/mods/alpha.jar" "${alpha_object}"
[[ "$(stat --format '%a' -- "${alpha_object}")" == 444 ]]

# A wrong mode alone is repaired once the hash agrees; nothing is fetched.
chmod 0644 -- "$(object_path "${beta_sha}")"
out="$(download 1.0)"
grep -qx 'fetched=0' <<<"${out}"
[[ "$(stat --format '%a' -- "$(object_path "${beta_sha}")")" == 444 ]]

# A payload mod that is a plain copy becomes a link to the cache object.
rm -f -- "$(payload_of 1.0)/mods/beta.jar"
cp -- "${fixture}/src/mods/beta.jar" "$(payload_of 1.0)/mods/beta.jar"
download 1.0 >/dev/null
[[ "$(inode "$(payload_of 1.0)/mods/beta.jar")" == "$(inode "$(object_path "${beta_sha}")")" ]]

# A wrong object in S3 fails the download, names the digest and the release,
# and never reaches the cache.
printf 'delta mod\n' >"${fixture}/src/mods/delta.jar"
delta_sha="$(put_object "${fixture}/src/mods/delta.jar")"
printf 'DELTA MOD\n' >"${bucket_root}/objects/sha256/${delta_sha:0:2}/${delta_sha}"
publish 1.4 ".server.mods += [{file: \"delta.jar\", sha256: \"${delta_sha}\", bytes: 10}]"
fails_with "${delta_sha}" download 1.4
fails_with "1.4" download 1.4
[[ ! -e "$(object_path "${delta_sha}")" ]]
[[ ! -e "$(payload_of 1.4)/manifest.json" && ! -e "$(payload_of 1.4)/mods/delta.jar" ]]
[[ -z "$(find "${cache}" -name '.fetch.*' -print -quit)" ]]
# A wrong size is also refused.
printf 'longer wrong bytes\n' >"${bucket_root}/objects/sha256/${delta_sha:0:2}/${delta_sha}"
fails_with "${delta_sha}" download 1.4
# A missing object is refused.
rm -f -- "${bucket_root}/objects/sha256/${delta_sha:0:2}/${delta_sha}"
fails_with "${delta_sha}" download 1.4
[[ ! -e "$(payload_of 1.4)/manifest.json" ]]

# A symbolic link in the cache path is refused.
mv -- "${cache}/sha256" "${cache}/sha256.real"
ln -s -- "${cache}/sha256.real" "${cache}/sha256"
fails_with "symbolic link" download 1.0
rm -- "${cache}/sha256"
mv -- "${cache}/sha256.real" "${cache}/sha256"
mv -- "${cache}/sha256/${beta_sha:0:2}" "${fixture}/aside"
ln -s -- "${fixture}/aside" "${cache}/sha256/${beta_sha:0:2}"
fails_with "symbolic link" download 1.0
rm -- "${cache}/sha256/${beta_sha:0:2}"
mv -- "${fixture}/aside" "${cache}/sha256/${beta_sha:0:2}"

# --- (c0) by default a staged mod is a copy: the container cannot reach the cache object ---
default_target="${host}/default/mods"
SERVER_PROJECT_DIRECTORY="${host}" "${SCRIPTS}/reconcile-release.sh" "$(payload_of 1.0)/manifest.json" "${default_target}" >/dev/null
for pair in "alpha.jar:${alpha_sha}" "beta.jar:${beta_sha}"; do
  mod="${pair%%:*}" digest="${pair##*:}"
  [[ "$(inode "${default_target}/${mod}")" != "$(inode "$(object_path "${digest}")")" ]] || fail "${mod} is linked by default"
  [[ "$(stat --format '%a' -- "${default_target}/${mod}")" == "644" ]] || fail "${mod} default mode"
done
rm -rf -- "${host}/default"
fails_with "OBJECT_CACHE_STAGE_MODE" env OBJECT_CACHE_STAGE_MODE=hardest SERVER_PROJECT_DIRECTORY="${host}" "${SCRIPTS}/reconcile-release.sh" "$(payload_of 1.0)/manifest.json" "${host}/bad/mods"

# --- (c) staging links mods and copies overrides (OBJECT_CACHE_STAGE_MODE=link) ---
export OBJECT_CACHE_STAGE_MODE=link
target="${host}/mods"
recon="$(SERVER_PROJECT_DIRECTORY="${host}" "${SCRIPTS}/reconcile-release.sh" "$(payload_of 1.0)/manifest.json" "${target}")"
grep -qx 'result=reconciled' <<<"${recon}"
grep -qx 'mods=2' <<<"${recon}"
for pair in "alpha.jar:${alpha_sha}" "beta.jar:${beta_sha}"; do
  mod="${pair%%:*}" digest="${pair##*:}"
  [[ "$(inode "${target}/${mod}")" == "$(inode "$(object_path "${digest}")")" ]] || fail "${mod} is not a link of the cache object"
  (($(links "${target}/${mod}") >= 3)) || fail "${mod} link count $(links "${target}/${mod}")"
  [[ "$(stat --format '%a %u' -- "${target}/${mod}")" == "444 0" ]] || fail "${mod} mode or owner"
done
mkdir -p -- "${fixture}/data"
SERVER_PROJECT_DIRECTORY="${host}" "${SCRIPTS}/reconcile-server-overrides.sh" "$(payload_of 1.0)/manifest.json" "${fixture}/data" >/dev/null
for pair in "config/a.toml:${cfg_a_sha}" "config/b.toml:${cfg_b_sha}"; do
  path="${pair%%:*}" digest="${pair##*:}"
  [[ "$(links "$(payload_of 1.0)/overrides/${path}")" == 1 ]] || fail "override ${path} is linked"
  [[ "$(inode "$(payload_of 1.0)/overrides/${path}")" != "$(inode "$(object_path "${digest}")")" ]]
  [[ "$(links "${fixture}/data/${path}")" == 1 ]]
done
# A mod that rewrites its config must not reach the cache.
printf 'rewritten\n' >"$(payload_of 1.0)/overrides/config/a.toml"
[[ "$(sha "$(object_path "${cfg_a_sha}")")" == "${cfg_a_sha}" ]]
download 1.0 >/dev/null
cmp -- "${fixture}/src/overrides/config/a.toml" "$(payload_of 1.0)/overrides/config/a.toml"
"${SCRIPTS}/verify-installed-release.sh" "$(payload_of 1.0)/manifest.json" "${target}" >/dev/null

# --- (d) the start-time check ---
reconcile() {
  SERVER_PROJECT_DIRECTORY="${host}" "${SCRIPTS}/reconcile-release.sh" "$(payload_of 1.0)/manifest.json" "${target}"
}
reconcile_with() {
  local check="$1"
  env OBJECT_CACHE_START_CHECK="${check}" SERVER_PROJECT_DIRECTORY="${host}" "${SCRIPTS}/reconcile-release.sh" "$(payload_of 1.0)/manifest.json" "${target}"
}
reconcile_with size >/dev/null
reconcile_with hash >/dev/null
fails_with "OBJECT_CACHE_START_CHECK" reconcile_with sloppy

# Same size, wrong bytes: the default hash check refuses; size mode does not hash.
chmod 0644 -- "${alpha_object}"
printf 'jar alpha BYTES\n' >"${alpha_object}"
chmod 0444 -- "${alpha_object}"
fails_with "SHA-256 mismatch" reconcile
fails_with "SHA-256 mismatch" reconcile_with hash
reconcile_with size >/dev/null
# Wrong size: refused in every mode.
chmod 0644 -- "${alpha_object}"
printf 'short\n' >"${alpha_object}"
chmod 0444 -- "${alpha_object}"
fails_with "size mismatch" reconcile_with size
fails_with "size mismatch" reconcile
# Wrong mode and wrong owner: refused by size mode.
cp -- "${fixture}/src/mods/alpha.jar" "${fixture}/alpha.good"
chmod 0644 -- "${alpha_object}"
cp -- "${fixture}/alpha.good" "${alpha_object}"
chmod 0644 -- "${alpha_object}"
fails_with "root-owned 0444" reconcile_with size
chmod 0444 -- "${alpha_object}"
chown 1000:1000 -- "${alpha_object}"
fails_with "root-owned 0444" reconcile_with size
reconcile_with hash >/dev/null
chown 0:0 -- "${alpha_object}"
reconcile_with size >/dev/null
# A missing object is refused.
mv -- "${alpha_object}" "${fixture}/alpha.aside"
fails_with "${alpha_sha}" reconcile
mv -- "${fixture}/alpha.aside" "${alpha_object}"
reconcile >/dev/null
# An unknown layout is refused by the reconciler as well.
jq '.storage.layout = "objects-v9"' "$(payload_of 1.0)/manifest.json" >"${fixture}/v9.json"
fails_with "does not know" env SERVER_PROJECT_DIRECTORY="${host}" RELEASE_SOURCE_DIR="$(payload_of 1.0)" "${SCRIPTS}/reconcile-release.sh" "${fixture}/v9.json" "${target}"

# World data folders survive an objects-v1 reconcile, as for a legacy release.
mkdir -p -- "${target}/worldfolder"
printf 'keep\n' >"${target}/worldfolder/data"
reconcile >/dev/null
[[ "$(cat "${target}/worldfolder/data")" == keep ]]

# A target on another filesystem would copy; the copy is checked and works.
# (Simulated: ln is refused through a failing wrapper.)
mkdir -p -- "${fixture}/nolink"
cat >"${fixture}/nolink/ln" <<'EOF'
#!/bin/sh
exit 1
EOF
chmod 0755 "${fixture}/nolink/ln"
copy_target="${fixture}/copy-host/mods"
mkdir -p -- "${fixture}/copy-host"
PATH="${fixture}/nolink:${PATH}" reconcile_with hash >/dev/null
SERVER_PROJECT_DIRECTORY="${host}" PATH="${fixture}/nolink:${PATH}" OBJECT_CACHE_START_CHECK=size \
  "${SCRIPTS}/reconcile-release.sh" "$(payload_of 1.0)/manifest.json" "${copy_target}" >/dev/null
cmp -- "${fixture}/src/mods/beta.jar" "${copy_target}/beta.jar"
[[ "$(inode "${copy_target}/beta.jar")" != "$(inode "$(object_path "${beta_sha}")")" ]]
reconcile >/dev/null

# --- (f) eviction ---
evict() { "${SCRIPTS}/evict-object-cache.sh" "$@"; }
exists() {
  local digest="$1"
  [[ -f "$(object_path "${digest}")" ]]
}

# A cache of its own, so the fixtures above stay.
export OBJECT_CACHE_DIR="${fixture}/evict-cache"
mkdir -p -- "${OBJECT_CACHE_DIR}"
make_object() { # name age-in-days -> digest
  local name="$1" age="$2" digest file
  file="${fixture}/evict-src-${name}"
  printf 'object %s padding padding\n' "${name}" >"${file}"
  digest="$(sha "${file}")"
  mkdir -p -- "${OBJECT_CACHE_DIR}/sha256/${digest:0:2}"
  cp -- "${file}" "${OBJECT_CACHE_DIR}/sha256/${digest:0:2}/${digest}"
  chmod 0444 -- "${OBJECT_CACHE_DIR}/sha256/${digest:0:2}/${digest}"
  touch -d "${age} days ago" -- "${OBJECT_CACHE_DIR}/sha256/${digest:0:2}/${digest}"
  printf '%s' "${digest}"
}
cache="${OBJECT_CACHE_DIR}"
old1="$(make_object old1 50)"
old2="$(make_object old2 40)"
kept_old="$(make_object kept 60)"
linked_old="$(make_object linked 70)"
newest="$(make_object newest 1)"
ln -- "$(object_path "${linked_old}")" "${fixture}/installed-link"
mkdir -p -- "${host}/releases/minecraft/main/9.0"
jq -n --arg k "${kept_old}" '{server: {mods: [{file: "k.jar", sha256: $k, bytes: 1}], overrides: []}}' \
  >"${host}/releases/minecraft/main/9.0/manifest.json"
export OBJECT_CACHE_MIN_FREE_GB=1
free_low=$((1024 * 1024 - 1)) # KB: one KB below the limit

# Plenty of space: nothing happens.
out="$(OBJECT_CACHE_FREE_KB_OVERRIDE=$((1024 * 1024)) evict --keep minecraft/main/9.0)"
grep -qx 'result=nothing_to_evict' <<<"${out}"
exists "${old1}"

# Dry run: counts, changes nothing.
out="$(OBJECT_CACHE_FREE_KB_OVERRIDE="${free_low}" OBJECT_CACHE_EVICT_DRY_RUN=true evict --keep minecraft/main/9.0)"
grep -qx 'dry_run=true' <<<"${out}"
grep -qx 'result=evicted' <<<"${out}"
for digest in "${old1}" "${old2}" "${kept_old}" "${linked_old}" "${newest}"; do exists "${digest}" || fail "dry run removed a file"; done

# One KB short: the oldest evictable file goes (the kept and the linked ones are older but protected).
out="$(OBJECT_CACHE_FREE_KB_OVERRIDE="${free_low}" evict --keep minecraft/main/9.0)"
grep -qx 'result=evicted' <<<"${out}"
grep -qx 'evicted=1' <<<"${out}" || fail "evicted count: ${out}"
grep -qx 'protected=2' <<<"${out}" || fail "protected count: ${out}"
grep -Eqx 'bytes=[0-9]+' <<<"${out}"
exists "${old1}" && fail "oldest evictable file is still there"
for digest in "${old2}" "${kept_old}" "${linked_old}" "${newest}"; do exists "${digest}" || fail "wrong file evicted"; done

# Far below the limit: everything evictable goes, protected files stay.
out="$(OBJECT_CACHE_FREE_KB_OVERRIDE=0 evict --keep minecraft/main/9.0)"
exists "${old2}" && fail "old2 survived"
exists "${newest}" && fail "newest survived"
exists "${kept_old}" || fail "kept release file evicted"
exists "${linked_old}" || fail "linked file evicted"
grep -qx 'result=evicted' <<<"${out}"
[[ -z "$(find "${OBJECT_CACHE_DIR}/sha256" -mindepth 1 -type d -empty -print -quit)" ]]
out="$(OBJECT_CACHE_FREE_KB_OVERRIDE=0 evict --keep minecraft/main/9.0)"
grep -qx 'result=nothing_to_evict' <<<"${out}"

# An unreadable keep manifest evicts nothing and fails.
extra="$(make_object extra 80)"
fails_with "kept release" env OBJECT_CACHE_FREE_KB_OVERRIDE=0 "${SCRIPTS}/evict-object-cache.sh" --keep minecraft/main/9.0 --keep minecraft/main/9.9
exists "${extra}" || fail "a file was evicted with an unreadable keep manifest"
printf 'not json' >"${host}/releases/minecraft/main/9.0/manifest.json"
fails_with "not valid" env OBJECT_CACHE_FREE_KB_OVERRIDE=0 "${SCRIPTS}/evict-object-cache.sh" --keep minecraft/main/9.0
exists "${extra}" || fail "a file was evicted with an invalid keep manifest"
expect_failure "bad keep argument" evict --keep ../x
expect_failure "unknown option" evict --now
unset OBJECT_CACHE_DIR OBJECT_CACHE_MIN_FREE_GB

# --- (g) an old host meeting an objects-v1 release fails safely ---
old_host="${fixture}/old-host"
mkdir -p -- "${old_host}/scripts" "${old_host}/payload-root"
cp -- "${REPOSITORY_ROOT}/server/tests/fixtures/legacy-host/download-release.sh" "${old_host}/scripts/"
cp -- "${SCRIPTS}/_common.sh" "${SCRIPTS}/_s3.sh" "${old_host}/scripts/"
old_payload="${old_host}/payload-root/releases/minecraft/main/1.0"
fails_with "could not download" env SERVER_PROJECT_DIRECTORY="${old_host}" \
  "${old_host}/scripts/download-release.sh" minecraft main 1.0 "${old_payload}"
[[ ! -e "${old_payload}/manifest.json" ]]
[[ -z "$(find "${old_payload}/mods" "${old_payload}/overrides" -type f -print -quit)" ]] || fail "the old host loaded a file"
[[ ! -e "${old_host}/mods" ]]

# --- (e) a legacy manifest keeps its behaviour and says so ---
legacy="${bucket_root}/releases/minecraft/main/2.0"
mkdir -p -- "${legacy}/mods" "${legacy}/overrides/config"
# Bytes no other release holds, so the sibling-reuse rule does not apply.
printf 'legacy only jar\n' >"${legacy}/mods/legacy.jar"
printf 'legacy = true\n' >"${legacy}/overrides/config/legacy.toml"
publish 2.0 "del(.storage) | .server.mods = [{file: \"legacy.jar\", sha256: \"$(sha "${legacy}/mods/legacy.jar")\", bytes: $(stat --format %s "${legacy}/mods/legacy.jar")}] |
  .server.overrides = [{path: \"config/legacy.toml\", sha256: \"$(sha "${legacy}/overrides/config/legacy.toml")\", bytes: $(stat --format %s "${legacy}/overrides/config/legacy.toml")}]"
legacy_out="$(download 2.0)"
grep -qx 'layout=legacy' <<<"${legacy_out}" || fail "legacy layout line: ${legacy_out}"
grep -qx 'downloaded=2' <<<"${legacy_out}"
[[ "$(links "$(payload_of 2.0)/mods/legacy.jar")" == 1 ]] || fail "a legacy payload file is linked to the object cache"
SERVER_PROJECT_DIRECTORY="${host}" "${SCRIPTS}/reconcile-release.sh" "$(payload_of 2.0)/manifest.json" "${fixture}/legacy-host/mods" >/dev/null
[[ "$(links "${fixture}/legacy-host/mods/legacy.jar")" == 1 ]]
[[ "$(stat --format '%a' -- "${fixture}/legacy-host/mods/legacy.jar")" == 644 ]]
# A legacy reconcile ignores the start-check setting except to validate it.
OBJECT_CACHE_START_CHECK=size SERVER_PROJECT_DIRECTORY="${host}" \
  "${SCRIPTS}/reconcile-release.sh" "$(payload_of 2.0)/manifest.json" "${fixture}/legacy-host/mods" >/dev/null

printf 'object cache test passed\n'
