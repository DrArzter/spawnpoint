#!/usr/bin/env bash

# scripts/release-files.sh: a person's view of the release bucket in both
# layouts. It reads manifests and lists keys; it never writes.

set -Eeuo pipefail

REPOSITORY_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
TOOL="${REPOSITORY_ROOT}/scripts/release-files.sh"
fixture="$(mktemp -d /tmp/spawnpoint-release-files-test.XXXXXXXX)"
trap 'rm -rf -- "${fixture}"' EXIT

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

mkdir -p -- "${fixture}/bin"
ln -s -- "${REPOSITORY_ROOT}/server/tests/fake-aws" "${fixture}/bin/aws"
export PATH="${fixture}/bin:${PATH}"
export FAKE_S3_ROOT="${fixture}/fake-s3"
export RELEASE_BUCKET="spawnpoint-test-releases"
export FAKE_AWS_CALL_LOG="${fixture}/calls"
bucket="${FAKE_S3_ROOT}/${RELEASE_BUCKET}"

sha() {
  local file="$1"
  sha256sum -- "${file}" | cut -d' ' -f1
}
bytes() {
  local file="$1"
  wc -c <"${file}" | tr -d ' '
}

mkdir -p -- "${fixture}/src"
printf 'alpha jar\n' >"${fixture}/src/alpha.jar"
printf 'beta jar bytes\n' >"${fixture}/src/beta.jar"
printf 'a = 1\n' >"${fixture}/src/a.toml"
printf 'client pack\n' >"${fixture}/src/client.zip"
printf 'server pack\n' >"${fixture}/src/server.zip"
alpha="$(sha "${fixture}/src/alpha.jar")"
beta="$(sha "${fixture}/src/beta.jar")"
config="$(sha "${fixture}/src/a.toml")"
client="$(sha "${fixture}/src/client.zip")"
server="$(sha "${fixture}/src/server.zip")"

manifest() {
  local release="$1" layout="$2" mods="$3"
  jq -n --arg release "${release}" --arg layout "${layout}" --argjson mods "${mods}" \
    --arg config "${config}" --argjson config_bytes "$(bytes "${fixture}/src/a.toml")" \
    --arg client "${client}" --argjson client_bytes "$(bytes "${fixture}/src/client.zip")" \
    --arg server "${server}" --argjson server_bytes "$(bytes "${fixture}/src/server.zip")" '{
      schema_version: 1, game: "minecraft", release: $release, created_at: "2026-11-23T10:00:00Z",
      source_profile: {id: "prominence", repository: "https://example.invalid/config", commit: ("c" * 40)},
      server: {mods: $mods, overrides: [{path: "config/a.toml", sha256: $config, bytes: $config_bytes}]},
      client: {file: "client.zip", kind: "mod-set", sha256: $client, bytes: $client_bytes}
    }
    | if $layout == "legacy" then . else
        .storage = {layout: $layout} | .packs = {server: {sha256: $server, bytes: $server_bytes}}
      end'
}
mod() {
  local file="$1" digest="$2" size="$3"
  jq -n --arg file "${file}" --arg sha "${digest}" --argjson bytes "${size}" '{file: $file, sha256: $sha, bytes: $bytes}'
}
alpha_mod="$(mod alpha.jar "${alpha}" "$(bytes "${fixture}/src/alpha.jar")")"
beta_mod="$(mod Beta-Mod.jar "${beta}" "$(bytes "${fixture}/src/beta.jar")")"

# A legacy release: its files and packs under its own keys.
legacy="${bucket}/releases/minecraft/prominence/1.0"
mkdir -p -- "${legacy}/mods" "${legacy}/overrides/config"
manifest 1.0 legacy "[${alpha_mod}]" >"${legacy}/manifest.json"
cp -- "${fixture}/src/alpha.jar" "${legacy}/mods/alpha.jar"
cp -- "${fixture}/src/a.toml" "${legacy}/overrides/config/a.toml"
cp -- "${fixture}/src/client.zip" "${legacy}/client.zip"
cp -- "${fixture}/src/server.zip" "${legacy}/server.zip"

# An objects-v1 release: only its manifest under the release key.
current="${bucket}/releases/minecraft/prominence/2.0"
mkdir -p -- "${current}"
manifest 2.0 objects-v1 "[${alpha_mod}, ${beta_mod}]" >"${current}/manifest.json"
for file in alpha.jar beta.jar a.toml client.zip server.zip; do
  digest="$(sha "${fixture}/src/${file}")"
  mkdir -p -- "${bucket}/objects/sha256/${digest:0:2}"
  cp -- "${fixture}/src/${file}" "${bucket}/objects/sha256/${digest:0:2}/${digest}"
done

# Another game, and a key that is no canonical manifest.
mkdir -p -- "${bucket}/releases/factorio/main/3.0" "${bucket}/releases/9.9"
manifest 3.0 legacy "[${alpha_mod}]" | jq '.game = "factorio"' >"${bucket}/releases/factorio/main/3.0/manifest.json"
manifest 9.9 legacy "[${alpha_mod}]" >"${bucket}/releases/9.9/manifest.json"

# --- show: a legacy release names its own keys, packs included ---
out="$("${TOOL}" show minecraft prominence 1.0 2>"${fixture}/err")"
[[ "$(head -1 <<<"${out}")" == $'kind\tpath\tbytes\tsha256\ts3_key' ]] || fail "show header: ${out}"
grep -qx $'mod\tmods/alpha.jar\t10\t'"${alpha}"$'\treleases/minecraft/prominence/1.0/mods/alpha.jar' <<<"${out}" || fail "legacy mod row: ${out}"
grep -qx $'override\toverrides/config/a.toml\t6\t'"${config}"$'\treleases/minecraft/prominence/1.0/overrides/config/a.toml' <<<"${out}" ||
  fail "legacy override row: ${out}"
grep -qx $'pack\tclient.zip\t12\t'"${client}"$'\treleases/minecraft/prominence/1.0/client.zip' <<<"${out}" || fail "legacy client row: ${out}"
grep -qx $'pack\tserver.zip\t12\t-\treleases/minecraft/prominence/1.0/server.zip' <<<"${out}" || fail "legacy server pack row: ${out}"
[[ "$(grep -c '^pack' <<<"${out}")" == 2 ]] || fail "a pack is listed twice: ${out}"
grep -q 'layout legacy, created 2026-11-23T10:00:00Z, source https://example.invalid/config@cccccccccccc' "${fixture}/err" ||
  fail "show summary: $(cat "${fixture}/err")"

# --- show: an objects-v1 release maps each name to its object ---
out="$("${TOOL}" show minecraft prominence 2.0 2>"${fixture}/err")"
grep -qx $'mod\tmods/alpha.jar\t10\t'"${alpha}"$'\tobjects/sha256/'"${alpha:0:2}/${alpha}" <<<"${out}" || fail "objects mod row: ${out}"
grep -qx $'mod\tmods/Beta-Mod.jar\t15\t'"${beta}"$'\tobjects/sha256/'"${beta:0:2}/${beta}" <<<"${out}" || fail "objects second mod: ${out}"
grep -qx $'pack\tserver.zip\t12\t'"${server}"$'\tobjects/sha256/'"${server:0:2}/${server}" <<<"${out}" || fail "objects server pack: ${out}"
grep -q 'layout objects-v1' "${fixture}/err" || fail "objects-v1 summary"

# --- find: a name in any release of the game, in any case ---
out="$("${TOOL}" find minecraft ALPHA)"
[[ "$(head -1 <<<"${out}")" == $'preset\trelease\tkind\tpath\tbytes\tsha256' ]] || fail "find header: ${out}"
grep -qx $'prominence\t1.0\tmod\tmods/alpha.jar\t10\t'"${alpha}" <<<"${out}" || fail "find in 1.0: ${out}"
grep -qx $'prominence\t2.0\tmod\tmods/alpha.jar\t10\t'"${alpha}" <<<"${out}" || fail "find in 2.0: ${out}"
[[ "$(wc -l <<<"${out}")" == 3 ]] || fail "find reached another game or a non-canonical key: ${out}"
out="$("${TOOL}" find minecraft beta-mod)"
grep -qx $'prominence\t2.0\tmod\tmods/Beta-Mod.jar\t15\t'"${beta}" <<<"${out}" || fail "find ignores case: ${out}"
[[ "$("${TOOL}" find minecraft nothing-like-this)" == $'preset\trelease\tkind\tpath\tbytes\tsha256' ]] || fail "find without a match"

# --- object: is it stored, and who names it, in every game ---
for wanted in "${alpha}" "objects/sha256/${alpha:0:2}/${alpha}"; do
  out="$("${TOOL}" object "${wanted}" 2>"${fixture}/err")"
  grep -q "object objects/sha256/${alpha:0:2}/${alpha} is stored, 10 bytes" "${fixture}/err" || fail "object stored line"
  grep -qx $'minecraft\tprominence\t1.0\tlegacy\tmod\tmods/alpha.jar' <<<"${out}" || fail "object in 1.0: ${out}"
  grep -qx $'minecraft\tprominence\t2.0\tobjects-v1\tmod\tmods/alpha.jar' <<<"${out}" || fail "object in 2.0: ${out}"
  grep -qx $'factorio\tmain\t3.0\tlegacy\tmod\tmods/alpha.jar' <<<"${out}" || fail "object in another game: ${out}"
  [[ "$(wc -l <<<"${out}")" == 4 ]] || fail "object rows: ${out}"
done
out="$("${TOOL}" object "${client}" 2>/dev/null)"
grep -qx $'minecraft\tprominence\t2.0\tobjects-v1\tpack\tclient.zip' <<<"${out}" || fail "a pack object: ${out}"
unknown="$(printf '%064d' 0)"
out="$("${TOOL}" object "${unknown}" 2>"${fixture}/err")"
grep -q 'is not in the store' "${fixture}/err" || fail "unknown object line"
[[ "${out}" == $'game\tpreset\trelease\tlayout\tkind\tpath' ]] || fail "unknown object rows: ${out}"

# --- it only reads ---
if grep -qvE '^s3api (list-objects-v2|get-object) ' "${FAKE_AWS_CALL_LOG}"; then
  fail "a call that is not a read: $(grep -vE '^s3api (list-objects-v2|get-object) ' "${FAKE_AWS_CALL_LOG}")"
fi

# --- bad input is refused before any call ---
expect_exit() {
  local code="$1" status=0
  shift
  "$@" >/dev/null 2>&1 || status=$?
  [[ "${status}" == "${code}" ]] || fail "expected exit ${code}, got ${status}: $*"
}
: >"${FAKE_AWS_CALL_LOG}"
expect_exit 2 "${TOOL}"
expect_exit 2 "${TOOL}" list minecraft
expect_exit 2 "${TOOL}" show minecraft prominence latest
expect_exit 2 "${TOOL}" show Minecraft prominence 1.0
expect_exit 2 "${TOOL}" find minecraft ""
expect_exit 2 "${TOOL}" object not-a-digest
[[ ! -s "${FAKE_AWS_CALL_LOG}" ]] || fail "bad input reached AWS: $(cat "${FAKE_AWS_CALL_LOG}")"
expect_exit 1 "${TOOL}" show minecraft prominence 7.7

printf 'release-files tests passed\n'
