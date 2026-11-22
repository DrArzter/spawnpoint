#!/usr/bin/env bash

# The upstream cache (incremental builds, stage 3) with a fake S3 and a fake
# CurseForge: first population, a hit that skips the dependency metadata calls
# and every download, a miss, a mismatch that falls back to CurseForge, and
# the addon keys. No network.

set -Eeuo pipefail

repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
resolver="${repository_root}/server/scripts/resolve-curseforge-modpack.sh"
addons_resolver="${repository_root}/server/scripts/resolve-addons.sh"
fixture="$(mktemp -d /tmp/spawnpoint-upstream-cache-test.XXXXXXXX)"
cleanup() {
  rm -rf -- "${fixture}"
}
trap cleanup EXIT

# The awk program that keeps a digest and drops the file name.
# shellcheck disable=SC2016 # awk program, not a shell expansion
first_field='{print $1}'

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

mkdir -p -- "${fixture}/bin" "${fixture}/api" "${fixture}/downloads" "${fixture}/s3" \
  "${fixture}/client/overrides/config" "${fixture}/server/Pack/mods" "${fixture}/server/Pack/config" \
  "${fixture}/mirror/overrides/mods" "${fixture}/modrinth/AbCdEf12"
ln -s -- "${repository_root}/server/tests/fake-aws" "${fixture}/bin/aws"

printf '{"manifestType":"minecraftModpack","manifestVersion":1,"overrides":"overrides","files":[{"projectID":111,"fileID":101},{"projectID":222,"fileID":102},{"projectID":333,"fileID":103}],"minecraft":{"version":"1.20.1","modLoaders":[{"id":"fabric-0.19.3","primary":true}]}}\n' \
  >"${fixture}/client/manifest.json"
printf 'client config\n' >"${fixture}/client/overrides/config/client.json"
(cd "${fixture}/client" && zip -qr "${fixture}/downloads/client.zip" .)
printf 'server mod\n' >"${fixture}/server/Pack/mods/one.jar"
printf 'pack config\n' >"${fixture}/server/Pack/config/pack.json"
(cd "${fixture}/server" && zip -qr "${fixture}/downloads/server.zip" .)
printf 'client only mod\n' >"${fixture}/downloads/client-only.jar"
printf 'textures\n' >"${fixture}/downloads/textures.zip"
printf 'bundled shaders\n' >"${fixture}/downloads/shaders.zip"
# The mirror bundles one dependency, so that file never needs a download.
cp -- "${fixture}/downloads/shaders.zip" "${fixture}/mirror/overrides/mods/shaders.zip"
(cd "${fixture}/mirror" && zip -qr "${fixture}/downloads/mirror.zip" .)

file_json() {
  local project="$1" id="$2" file="$3" extra="${4:-null}"
  # Fixture mirrors CurseForge's documented SHA-1 integrity field.
  local sha
  sha="$(sha1sum "${fixture}/downloads/${file}" | awk "${first_field}")" # NOSONAR test fixture: the fake CurseForge API answers SHA-1, as the real one does
  jq -n --argjson project "${project}" --argjson id "${id}" --arg file "${file}" \
    --argjson bytes "$(stat --format '%s' "${fixture}/downloads/${file}")" \
    --arg sha "${sha}" \
    --argjson extra "${extra}" '
      {data: ({id: $id, modId: $project, fileName: $file, fileLength: $bytes,
        downloadUrl: ("https://downloads.invalid/" + $file), hashes: [{algo: 1, value: $sha}],
        gameVersions: ["1.20.1", "Fabric"]} + ($extra // {}))}'
}
file_json 466901 9184727 client.zip '{"serverPackFileId":9184730}' >"${fixture}/api/9184727.json"
file_json 466901 9184730 server.zip '{"parentProjectFileId":9184727}' >"${fixture}/api/9184730.json"
file_json 111 101 client-only.jar >"${fixture}/api/101.json"
file_json 222 102 textures.zip >"${fixture}/api/102.json"
file_json 333 103 shaders.zip '{"downloadUrl":null}' >"${fixture}/api/103.json"
printf '{"data":{"id":111,"gameId":432,"classId":6}}\n' >"${fixture}/api/project-111.json"
printf '{"data":{"id":222,"gameId":432,"classId":12}}\n' >"${fixture}/api/project-222.json"
printf '{"data":{"id":333,"gameId":432,"classId":6552}}\n' >"${fixture}/api/project-333.json"

# FAKE_OFFLINE=1 refuses every download, so only the cache can supply bytes.
cat >"${fixture}/bin/curl" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
output=
url=
while (( $# > 0 )); do
  case "$1" in
    -o) output="$2"; shift 2 ;;
    -H) shift 2 ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
printf '%s\n' "${url}" >>"${FAKE_ROOT}/curl.log"
case "${url}" in
  */v1/mods/*/files/*) source="${FAKE_ROOT}/api/${url##*/}.json" ;;
  */v1/mods/*) source="${FAKE_ROOT}/api/project-${url##*/}.json" ;;
  https://downloads.invalid/*)
    [[ "${FAKE_OFFLINE:-0}" != 1 ]] || exit 22
    source="${FAKE_ROOT}/downloads/${url##*/}"
    ;;
  https://cdn.modrinth.com/data/*)
    [[ "${FAKE_OFFLINE:-0}" != 1 ]] || exit 22
    rest="${url#https://cdn.modrinth.com/data/}"
    source="${FAKE_ROOT}/modrinth/${rest#*/versions/}"
    ;;
  *) exit 22 ;;
esac
[[ -f "${source}" ]] || exit 22
if [[ -n "${output}" ]]; then cp -- "${source}" "${output}"; else cat -- "${source}"; fi
EOF
chmod 0755 "${fixture}/bin/curl"

jq -n --arg sha "$(sha512sum "${fixture}/downloads/mirror.zip" | awk "${first_field}")" \
  --argjson bytes "$(stat --format '%s' "${fixture}/downloads/mirror.zip")" '
  {schema_version:1,project_id:466901,file_id:9184727,server_pack_file_id:9184730,
    client_mirror:{url:"https://downloads.invalid/mirror.zip",sha512:$sha,bytes:$bytes}}
' >"${fixture}/source.json"

bucket=spawnpoint-test-releases
cache="${fixture}/s3/${bucket}/upstream"
run_resolver() {
  local output="$1"
  shift
  : >"${fixture}/curl.log"
  : >"${fixture}/aws.log"
  env PATH="${fixture}/bin:${PATH}" CF_API_KEY=test-key FAKE_ROOT="${fixture}" \
    FAKE_S3_ROOT="${fixture}/s3" FAKE_AWS_CALL_LOG="${fixture}/aws.log" "$@" \
    "${resolver}" "${fixture}/source.json" "${fixture}/${output}"
}
value() {
  awk -F= -v key="$1" '$1 == key { print $2 }' <<<"$2"
}
downloads() {
  grep -c '^https://downloads.invalid/' "${fixture}/curl.log" || true
}

# Without a cache bucket the resolver behaves as before and calls no S3.
output="$(run_resolver plain)"
[[ -z "$(value upstream_cache_hits "${output}")" ]] || fail "a resolver without a cache bucket reports a cache"
[[ ! -s "${fixture}/aws.log" ]] || fail "a resolver without a cache bucket calls S3"

# First population: every lookup misses, and verified bytes enter the cache.
output="$(run_resolver first UPSTREAM_CACHE_BUCKET="${bucket}")"
[[ "$(value result "${output}")" == resolved ]] || fail "first population did not resolve"
[[ "$(value upstream_cache_hits "${output}")" == 0 ]] || fail "an empty cache reported a hit"
(( "$(value upstream_cache_misses "${output}")" >= 5 )) || fail "an empty cache did not report its misses"
cmp -s "${fixture}/plain/client.zip" "${fixture}/first/client.zip" || fail "the cache changed the client pack"
for key in 466901/9184727 466901/9184730 111/101 222/102 333/103; do
  [[ -f "${cache}/curseforge/${key}/file" && -f "${cache}/curseforge/${key}/index.json" ]] ||
    fail "the cache did not store ${key}"
done
cmp -s "${fixture}/downloads/server.zip" "${cache}/curseforge/466901/9184730/file" || fail "cached server pack bytes differ"
textures_sha1="$(sha1sum "${fixture}/downloads/textures.zip" | awk "${first_field}")" # NOSONAR test fixture: SHA-1 is what CurseForge publishes
jq -e --arg sha1 "${textures_sha1}" \
  --arg sha256 "$(sha256sum "${fixture}/downloads/textures.zip" | awk "${first_field}")" '
  .project_id == 222 and .file_id == 102 and .fileName == "textures.zip" and .classId == 12 and
  .sha1 == $sha1 and .sha256 == $sha256 and .fileLength > 0
' "${cache}/curseforge/222/102/index.json" >/dev/null || fail "the dependency index is incomplete"
mirror_sha="$(jq -r '.client_mirror.sha512' "${fixture}/source.json")"
cmp -s "${fixture}/downloads/mirror.zip" "${cache}/curseforge/466901/9184727/mirror/${mirror_sha}" ||
  fail "the cache did not store the client mirror by its SHA-512"
! grep -Eq -- '--key (objects|releases)/' "${fixture}/aws.log" || fail "cache bytes left upstream/"

# A hit: no download, and no metadata call for any client dependency.
output="$(run_resolver second UPSTREAM_CACHE_BUCKET="${bucket}" FAKE_OFFLINE=1)"
[[ "$(value result "${output}")" == resolved ]] || fail "a warm cache did not resolve offline"
[[ "$(value upstream_cache_misses "${output}")" == 0 ]] || fail "a warm cache missed"
[[ "$(value upstream_cache_rejected "${output}")" == 0 ]] || fail "a warm cache rejected an entry"
[[ "$(downloads)" == 0 ]] || fail "a warm cache still downloaded"
! grep -Eq '/v1/mods/(111|222|333)' "${fixture}/curl.log" || fail "a warm cache still asked for dependency metadata"
cmp -s "${fixture}/first/client.zip" "${fixture}/second/client.zip" || fail "a cache hit changed the client pack"
cmp -s "${fixture}/first/mods/one.jar" "${fixture}/second/mods/one.jar" || fail "a cache hit changed the server set"

# A mismatch: bytes that do not match the index are rejected, CurseForge
# supplies them, and the entry is written again.
printf 'tampered\n' >>"${cache}/curseforge/222/102/file"
output="$(run_resolver mismatch UPSTREAM_CACHE_BUCKET="${bucket}")"
[[ "$(value upstream_cache_rejected "${output}")" == 1 ]] || fail "tampered cache bytes were not rejected"
grep -Fxq 'https://downloads.invalid/textures.zip' "${fixture}/curl.log" || fail "a mismatch did not fall back to CurseForge"
cmp -s "${fixture}/first/client.zip" "${fixture}/mismatch/client.zip" || fail "a mismatch changed the client pack"
cmp -s "${fixture}/downloads/textures.zip" "${cache}/curseforge/222/102/file" || fail "a mismatch did not repair the cache"

# A pack index that disagrees with fresh CurseForge metadata is rejected too.
jq '.sha1 = "0000000000000000000000000000000000000000"' "${cache}/curseforge/466901/9184730/index.json" \
  >"${fixture}/bad-index.json"
cp -- "${fixture}/bad-index.json" "${cache}/curseforge/466901/9184730/index.json"
output="$(run_resolver bad-index UPSTREAM_CACHE_BUCKET="${bucket}")"
[[ "$(value upstream_cache_rejected "${output}")" == 1 ]] || fail "a disagreeing pack index was not rejected"
grep -Fxq 'https://downloads.invalid/server.zip' "${fixture}/curl.log" || fail "a disagreeing index did not fall back"

# A miss: an expired entry is fetched from CurseForge and stored again.
rm -rf -- "${cache}/curseforge/111"
output="$(run_resolver miss UPSTREAM_CACHE_BUCKET="${bucket}")"
[[ "$(value upstream_cache_misses "${output}")" == 1 ]] || fail "an expired entry was not a miss"
grep -q '/v1/mods/111' "${fixture}/curl.log" || fail "a miss did not ask CurseForge for metadata"
[[ -f "${cache}/curseforge/111/101/index.json" ]] || fail "a miss did not populate the cache"

# A cache that cannot be written never blocks a build.
rm -rf -- "${cache}"
output="$(run_resolver no-write UPSTREAM_CACHE_BUCKET="${bucket}" \
  FAKE_S3_PUT_FAIL_KEY=upstream/curseforge/466901/9184730/file)"
[[ "$(value result "${output}")" == resolved ]] || fail "a failed cache write blocked the build"
[[ ! -e "${cache}/curseforge/466901/9184730/index.json" ]] || fail "an index was written without its bytes"
cmp -s "${fixture}/first/client.zip" "${fixture}/no-write/client.zip" || fail "a failed cache write changed the client pack"

# Addons: CurseForge by project and file, Modrinth by version and SHA-512.
printf 'curseforge addon\n' >"${fixture}/downloads/addon.jar"
file_json 555 501 addon.jar >"${fixture}/api/501.json"
printf '{"data":{"id":555,"gameId":432,"classId":6}}\n' >"${fixture}/api/project-555.json"
printf 'modrinth addon\n' >"${fixture}/modrinth/AbCdEf12/modrinth-addon.jar"
modrinth_sha="$(sha512sum "${fixture}/modrinth/AbCdEf12/modrinth-addon.jar" | awk "${first_field}")"
mkdir -p "${fixture}/profile"
jq -n --arg sha "${modrinth_sha}" --argjson bytes "$(stat --format '%s' "${fixture}/modrinth/AbCdEf12/modrinth-addon.jar")" '
  {schema_version:1,mods:[
    {name:"CF addon",side:"both",curseforge:{project_id:555,file_id:501}},
    {name:"MR addon",side:"server",modrinth:{project_id:"PrOjEcT1",version_id:"AbCdEf12",file:"modrinth-addon.jar",sha512:$sha,bytes:$bytes}}]}
' >"${fixture}/profile/addons.json"
run_addons() {
  local output="$1"
  shift
  : >"${fixture}/curl.log"
  env PATH="${fixture}/bin:${PATH}" CF_API_KEY=test-key FAKE_ROOT="${fixture}" FAKE_S3_ROOT="${fixture}/s3" \
    ADDONS_MINECRAFT_VERSION=1.20.1 ADDONS_LOADER_TYPE=fabric UPSTREAM_CACHE_BUCKET="${bucket}" "$@" \
    "${addons_resolver}" "${fixture}/profile/addons.json" "${fixture}/profile" "${fixture}/${output}"
}
output="$(run_addons addons-first)"
[[ "$(value upstream_cache_misses "${output}")" == 2 ]] || fail "first addon resolution did not miss twice"
[[ -f "${cache}/curseforge/555/501/file" ]] || fail "the CurseForge addon was not cached by project and file"
jq -e '.classId == 6' "${cache}/curseforge/555/501/index.json" >/dev/null || fail "the addon index has no class"
cmp -s "${fixture}/modrinth/AbCdEf12/modrinth-addon.jar" "${cache}/modrinth/AbCdEf12/${modrinth_sha}" ||
  fail "the Modrinth addon was not cached by version and SHA-512"
output="$(run_addons addons-second FAKE_OFFLINE=1 UPSTREAM_CACHE_HITS_FILE="${fixture}/hits.tsv")"
[[ "$(value upstream_cache_hits "${output}")" == 2 ]] || fail "warm addon resolution did not hit twice"
# A CurseForge hit is recorded as a copy source for the objects-v1 writer; a SHA-512 hit has no SHA-256 to record.
[[ "$(cat "${fixture}/hits.tsv")" == "$(printf '%s\tupstream/curseforge/555/501/file' "$(sha256sum "${cache}/curseforge/555/501/file" | awk "${first_field}")")" ]] ||
  fail "the CurseForge hit was not recorded for the writer"
cmp -s "${fixture}/addons-first/addons-lock.json" "${fixture}/addons-second/addons-lock.json" ||
  fail "an addon cache hit changed the lock"
printf 'tampered\n' >>"${cache}/modrinth/AbCdEf12/${modrinth_sha}"
output="$(run_addons addons-mismatch)"
[[ "$(value upstream_cache_rejected "${output}")" == 1 ]] || fail "a tampered Modrinth entry was not rejected"
cmp -s "${fixture}/addons-first/addons-lock.json" "${fixture}/addons-mismatch/addons-lock.json" ||
  fail "a Modrinth mismatch changed the lock"

printf 'result=passed\n'
