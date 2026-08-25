#!/usr/bin/env bash

# The list-to-release chain (ADR-0028's first slice): pinned entries resolve
# into verified files, the cache heals, authentication is mandatory, an
# author-disabled download fails with instructions, and the whole cut lands a
# complete release in the (fake) bucket.

set -Eeuo pipefail

REPOSITORY_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPTS="${REPOSITORY_ROOT}/server/scripts"
fixture="$(mktemp -d /tmp/spawnpoint-cut-test.XXXXXXXX)"
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
ln -s -- "${REPOSITORY_ROOT}/server/tests/fake-curl" "${fixture}/bin/curl"
export PATH="${fixture}/bin:${PATH}"
export FAKE_S3_ROOT="${fixture}/fake-s3"
export FAKE_CF_ROOT="${fixture}/fake-cf"
export RELEASE_BUCKET="spawnpoint-test-releases"
export CF_API_KEY="test-key"
export CF_API_BASE="https://api.fake"

# --- CurseForge fixtures: two mods, pinned files, one download blob each ---
mkdir -p -- "${FAKE_CF_ROOT}/blobs"
printf 'alpha jar bytes\n' >"${FAKE_CF_ROOT}/blobs/alpha-1.2.3.jar"
printf 'beta jar bytes, longer\n' >"${FAKE_CF_ROOT}/blobs/beta-4.5.jar"

fixture_file_json() {
  local blob="$1" mod_id="$2" file_id="$3" name="$4" url="$5"
  jq -n \
    --arg name "${name}" \
    --arg url "${url}" \
    --arg sha1 "$(sha1sum -- "${blob}" | awk '{print $1}')" \
    --argjson bytes "$(stat --format '%s' -- "${blob}")" \
    '{data: {fileName: $name, fileLength: $bytes, downloadUrl: ($url | select(. != "") // null), hashes: [{value: $sha1, algo: 1}]}}' \
    >"${FAKE_CF_ROOT}/file-${mod_id}-${file_id}.json"
}

printf '{"data":[{"id":100,"slug":"alpha"}]}\n' >"${FAKE_CF_ROOT}/search-alpha.json"
printf '{"data":[{"id":200,"slug":"beta"},{"id":201,"slug":"beta-fork"}]}\n' >"${FAKE_CF_ROOT}/search-beta.json"
fixture_file_json "${FAKE_CF_ROOT}/blobs/alpha-1.2.3.jar" 100 111 "alpha-1.2.3.jar" "https://fake.download/alpha-1.2.3.jar"
fixture_file_json "${FAKE_CF_ROOT}/blobs/beta-4.5.jar" 200 222 "beta-4.5.jar" "https://fake.download/beta-4.5.jar"

cat >"${fixture}/world.list" <<'EOF'
# comment, then a blank line

alpha:111
beta:222
EOF

# --- resolve: fetch, verify, cache ---
resolve_output="$("${SCRIPTS}/resolve-mod-list.sh" "${fixture}/world.list" "${fixture}/payload")"
grep -qx 'resolved=2' <<<"${resolve_output}"
grep -qx 'downloaded=2' <<<"${resolve_output}"
cmp -- "${FAKE_CF_ROOT}/blobs/alpha-1.2.3.jar" "${fixture}/payload/mods/alpha-1.2.3.jar"

second_output="$("${SCRIPTS}/resolve-mod-list.sh" "${fixture}/world.list" "${fixture}/payload")"
grep -qx 'downloaded=0' <<<"${second_output}"
grep -qx 'kept=2' <<<"${second_output}"

printf 'tampered\n' >>"${fixture}/payload/mods/beta-4.5.jar"
heal_output="$("${SCRIPTS}/resolve-mod-list.sh" "${fixture}/world.list" "${fixture}/payload")"
grep -qx 'downloaded=1' <<<"${heal_output}"
cmp -- "${FAKE_CF_ROOT}/blobs/beta-4.5.jar" "${fixture}/payload/mods/beta-4.5.jar"

# --- refusals ---
expect_failure "a missing API key" \
  env -u CF_API_KEY "${SCRIPTS}/resolve-mod-list.sh" "${fixture}/world.list" "${fixture}/payload"

printf 'alpha:999\n' >"${fixture}/unknown-file.list"
expect_failure "an unknown pinned file id" \
  "${SCRIPTS}/resolve-mod-list.sh" "${fixture}/unknown-file.list" "${fixture}/payload2"

printf 'Alpha:111\n' >"${fixture}/bad-entry.list"
expect_failure "an unparseable entry" \
  "${SCRIPTS}/resolve-mod-list.sh" "${fixture}/bad-entry.list" "${fixture}/payload2"

mkdir -p -- "${FAKE_CF_ROOT}"
printf '{"data":[{"id":300,"slug":"nodl"}]}\n' >"${FAKE_CF_ROOT}/search-nodl.json"
fixture_file_json "${FAKE_CF_ROOT}/blobs/alpha-1.2.3.jar" 300 333 "nodl-1.0.jar" ""
printf 'nodl:333\n' >"${fixture}/nodl.list"
expect_failure "an author-disabled download" \
  "${SCRIPTS}/resolve-mod-list.sh" "${fixture}/nodl.list" "${fixture}/payload2"

# The corrupted-upstream case: blob bytes do not match the pinned hash.
printf '{"data":[{"id":400,"slug":"evil"}]}\n' >"${FAKE_CF_ROOT}/search-evil.json"
jq -n '{data: {fileName: "evil-1.0.jar", fileLength: 5, downloadUrl: "https://fake.download/evil-1.0.jar", hashes: [{value: "0000000000000000000000000000000000000000", algo: 1}]}}' \
  >"${FAKE_CF_ROOT}/file-400-444.json"
printf 'evil\n' >"${FAKE_CF_ROOT}/blobs/evil-1.0.jar"
printf 'evil:444\n' >"${fixture}/evil.list"
expect_failure "a download that does not match the pinned hash" \
  "${SCRIPTS}/resolve-mod-list.sh" "${fixture}/evil.list" "${fixture}/payload2"

# --- the whole cut: list in, published release out ---
cut_output="$("${REPOSITORY_ROOT}/scripts/cut-release.sh" "${fixture}/world.list" 2.0 1.20.1 47.4.0)"
grep -qx 'result=cut' <<<"${cut_output}"
grep -qx 'mods=2' <<<"${cut_output}"
grep -qx 'upload=uploaded' <<<"${cut_output}"
release_root="${FAKE_S3_ROOT}/${RELEASE_BUCKET}"
[[ -f "${release_root}/releases/2.0/manifest.json" ]]
[[ -f "${release_root}/releases/2.0/mods/alpha-1.2.3.jar" ]]
jq -e '.server.mods | length == 2' "${release_root}/releases/2.0/manifest.json" >/dev/null

# The client pack rides along: same payload as a zip, with the wholesale-replace
# instruction inside, immutable under packs/<release>.zip.
grep -qx 'pack=uploaded' <<<"${cut_output}"
pack="${release_root}/packs/2.0.zip"
[[ -f "${pack}" ]]
listing="$(unzip -l "${pack}")"
grep -q 'alpha-1.2.3.jar' <<<"${listing}"
grep -q 'beta-4.5.jar' <<<"${listing}"
grep -q 'INSTALL.txt' <<<"${listing}"

# Re-cutting the same release is idempotent end to end. The pack is recognised
# by existence, not digest — zips are not byte-reproducible — because release
# immutability was already enforced at the manifest gate.
second_cut="$("${REPOSITORY_ROOT}/scripts/cut-release.sh" "${fixture}/world.list" 2.0 1.20.1 47.4.0)" || {
  printf 'expected the second cut of an identical release to succeed idempotently\n' >&2
  exit 1
}
grep -qx 'upload=already_present' <<<"${second_cut}"
grep -qx 'pack=already_present' <<<"${second_cut}"

# A vanilla-like profile still has a real immutable release: exact Minecraft
# and Forge versions, with an intentionally empty mod array. Publishing it
# commits only the manifest and lets reconciliation remove every stale JAR.
mkdir -p -- "${fixture}/vanilla/mods"
"${SCRIPTS}/build-release-manifest.sh" \
  3.0 1.20.1 47.4.10 "${fixture}/vanilla/mods" "${fixture}/vanilla/manifest.json" >/dev/null
vanilla_upload="$(RELEASE_SOURCE_DIR="${fixture}/vanilla" \
  "${SCRIPTS}/upload-release.sh" "${fixture}/vanilla/manifest.json")"
grep -qx 'result=uploaded' <<<"${vanilla_upload}"
jq -e '.release == "3.0" and .server.mods == []' \
  "${release_root}/releases/3.0/manifest.json" >/dev/null
[[ -z "$(find "${release_root}/releases/3.0" -path '*/mods/*.jar' -print -quit)" ]]

# AWS CLI shorthand treats square brackets as syntax. Real mod filenames may
# contain them, so release metadata is passed as JSON and must remain opaque.
mkdir -p -- "${fixture}/special/mods"
special_mod="dungeons-and-taverns-3.0.3.f[Forge].jar"
printf 'special filename bytes\n' >"${fixture}/special/mods/${special_mod}"
"${SCRIPTS}/build-release-manifest.sh" \
  3.1 1.20.1 47.4.10 "${fixture}/special/mods" "${fixture}/special/manifest.json" >/dev/null
special_upload="$(RELEASE_SOURCE_DIR="${fixture}/special" \
  "${SCRIPTS}/upload-release.sh" "${fixture}/special/manifest.json")"
grep -qx 'result=uploaded' <<<"${special_upload}"
cmp -- "${fixture}/special/mods/${special_mod}" \
  "${release_root}/releases/3.1/mods/${special_mod}"

printf 'cut-release-test: ok\n'
