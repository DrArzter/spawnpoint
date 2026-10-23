#!/usr/bin/env bash

set -Eeuo pipefail

repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
resolver="${repository_root}/server/scripts/resolve-curseforge-modpack.sh"
fixture="$(mktemp -d /tmp/spawnpoint-curseforge-modpack-test.XXXXXXXX)"
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

mkdir -p -- "${fixture}/bin" "${fixture}/api" "${fixture}/downloads" \
  "${fixture}/client" "${fixture}/server/Prominence/mods" \
  "${fixture}/server/Prominence/config/prominence" \
  "${fixture}/server/Prominence/defaultconfigs"
printf '{"manifestType":"minecraftModpack","manifestVersion":1,"overrides":"overrides","files":[{"projectID":111,"fileID":101},{"projectID":222,"fileID":102},{"projectID":333,"fileID":103},{"projectID":444,"fileID":104}],"minecraft":{"version":"1.20.1","modLoaders":[{"id":"fabric-0.19.3","primary":true}]}}\n' \
  >"${fixture}/client/manifest.json"
mkdir -p "${fixture}/client/overrides/config" "${fixture}/client/overrides/resourcepacks" "${fixture}/client/overrides/custom-folder"
printf 'client config\n' >"${fixture}/client/overrides/config/client.json"
printf 'embedded textures\n' >"${fixture}/client/overrides/resourcepacks/embedded.zip"
printf 'custom content\n' >"${fixture}/client/overrides/custom-folder/data.txt"
printf 'client override\n' >"${fixture}/client/README.txt"
(cd "${fixture}/client" && zip -qr "${fixture}/downloads/client.zip" .)
printf 'fabric mod one\n' >"${fixture}/server/Prominence/mods/one.jar"
printf 'fabric mod two\n' >"${fixture}/server/Prominence/mods/two.jar"
printf 'pack config\n' >"${fixture}/server/Prominence/config/prominence/server.json"
printf 'defaults\n' >"${fixture}/server/Prominence/defaultconfigs/game.toml"
printf 'must not execute\n' >"${fixture}/server/Prominence/start.sh"
printf 'must not overwrite operator state\n' >"${fixture}/server/Prominence/server.properties"
mkdir -p "${fixture}/server/Prominence/vendor"
printf 'datapack\n' >"${fixture}/server/Prominence/vendor/datapack.zip"
(cd "${fixture}/server" && zip -qr "${fixture}/downloads/server.zip" .)
# Some authors publish a ZIP containing their actual server-pack ZIP.
mkdir "${fixture}/server-wrapper"
mv "${fixture}/downloads/server.zip" "${fixture}/server-wrapper/server-pack.zip"
(cd "${fixture}/server-wrapper" && zip -qr "${fixture}/downloads/server.zip" .)

file_json() {
  local id="$1" file="$2" extra="$3"
  local bytes sha
  bytes="$(stat --format '%s' "${fixture}/downloads/${file}")"
  # Fixture mirrors CurseForge's documented SHA-1 integrity field.
  sha="$(sha1sum "${fixture}/downloads/${file}" | awk '{print $1}')" # NOSONAR
  jq -n \
    --argjson id "${id}" \
    --arg file "${file}" \
    --argjson bytes "${bytes}" \
    --arg sha "${sha}" \
    --argjson extra "${extra}" '
      {data: ({id: $id, modId: 466901, fileName: $file, fileLength: $bytes,
        downloadUrl: ("https://downloads.invalid/" + $file), hashes: [{algo: 1, value: $sha}]} + $extra)}'
}
file_json 9184727 client.zip '{"serverPackFileId":9184730}' >"${fixture}/api/9184727.json"
file_json 9184730 server.zip '{"parentProjectFileId":9184727}' >"${fixture}/api/9184730.json"
printf 'client only mod\n' >"${fixture}/downloads/client-only.jar"
printf 'textures\n' >"${fixture}/downloads/textures.zip"
printf 'shaders\n' >"${fixture}/downloads/shaders.zip"
printf 'datapack\n' >"${fixture}/downloads/datapack.zip"
file_json 101 client-only.jar '{"modId":111,"downloadUrl":null}' >"${fixture}/api/101.json"
file_json 102 textures.zip '{"modId":222}' >"${fixture}/api/102.json"
file_json 103 shaders.zip '{"modId":333,"downloadUrl":null}' >"${fixture}/api/103.json"
file_json 104 datapack.zip '{"modId":444,"downloadUrl":null}' >"${fixture}/api/104.json"
printf '{"data":{"id":111,"gameId":432,"classId":6}}\n' >"${fixture}/api/project-111.json"
printf '{"data":{"id":222,"gameId":432,"classId":12}}\n' >"${fixture}/api/project-222.json"
printf '{"data":{"id":333,"gameId":432,"classId":6552}}\n' >"${fixture}/api/project-333.json"
printf '{"data":{"id":444,"gameId":432,"classId":6945}}\n' >"${fixture}/api/project-444.json"
jq '.data.downloadUrl = null' "${fixture}/api/9184730.json" >"${fixture}/api/9184730.tmp"
mv -- "${fixture}/api/9184730.tmp" "${fixture}/api/9184730.json"
printf '{"data":"https://downloads.invalid/server.zip"}\n' >"${fixture}/api/9184730-download.json"
mkdir -p "${fixture}/mirror/overrides/mods"
cp "${fixture}/downloads/client-only.jar" "${fixture}/mirror/overrides/mods/client-only.jar"
jq -n --arg sha "$(jq -r '.data.hashes[0].value' "${fixture}/api/103.json")" \
  --argjson bytes "$(stat --format '%s' "${fixture}/downloads/shaders.zip")" '
  {files:[{path:"shaderpacks/shaders.zip",hashes:{sha1:$sha},fileSize:$bytes,
    downloads:["https://downloads.invalid/shaders.zip"]}]}
' >"${fixture}/mirror/modrinth.index.json"
(cd "${fixture}/mirror" && zip -qr "${fixture}/downloads/mirror.zip" .)

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
[[ -n "${url}" && "${CF_API_KEY:-}" == test-key ]]
case "${url}" in
  */v1/mods/466901/files/9184730/download-url)
    source="${FAKE_CF_MODPACK_ROOT}/api/9184730-download.json"
    ;;
  */v1/mods/*/files/*)
    id="${url##*/}"
    source="${FAKE_CF_MODPACK_ROOT}/api/${id}.json"
    ;;
  */v1/mods/*)
    source="${FAKE_CF_MODPACK_ROOT}/api/project-${url##*/}.json"
    ;;
  https://downloads.invalid/*)
    source="${FAKE_CF_MODPACK_ROOT}/downloads/${url##*/}"
    ;;
  *) exit 22 ;;
esac
if [[ -n "${output}" ]]; then
  cp -- "${source}" "${output}"
else
  cat -- "${source}"
fi
EOF
chmod 0755 "${fixture}/bin/curl"

mirror_sha="$(sha512sum "${fixture}/downloads/mirror.zip" | awk '{print $1}')"
jq -n --arg sha "${mirror_sha}" --argjson bytes "$(stat --format '%s' "${fixture}/downloads/mirror.zip")" '
  {schema_version:1,project_id:466901,file_id:9184727,server_pack_file_id:9184730,
    client_mirror:{url:"https://downloads.invalid/mirror.zip",sha512:$sha,bytes:$bytes}}
' >"${fixture}/source.json"

output="$(
  PATH="${fixture}/bin:${PATH}" \
  CF_API_KEY=test-key \
  FAKE_CF_MODPACK_ROOT="${fixture}" \
  CURSEFORGE_EXPECTED_MINECRAFT_VERSION=1.20.1 \
  CURSEFORGE_EXPECTED_LOADER_TYPE=fabric \
  CURSEFORGE_EXPECTED_LOADER_VERSION=0.19.3 \
    "${resolver}" "${fixture}/source.json" "${fixture}/resolved"
)"
grep -Fxq 'result=resolved' <<<"${output}"
grep -Fxq 'mods=2' <<<"${output}"
grep -Fxq 'overrides=2' <<<"${output}"
mkdir "${fixture}/complete-client"
unzip -q "${fixture}/resolved/client.zip" -d "${fixture}/complete-client"
jq -e '.files == [] and .minecraft.modLoaders[0].id == "fabric-0.19.3"' \
  "${fixture}/complete-client/manifest.json" >/dev/null
jq -e '(.files | length) == 4 and (.upstream_manifest.files | length) == 4' \
  "${fixture}/complete-client/spawnpoint-client-lock.json" >/dev/null
cmp "${fixture}/downloads/client-only.jar" "${fixture}/complete-client/overrides/mods/client-only.jar"
cmp "${fixture}/downloads/textures.zip" "${fixture}/complete-client/overrides/resourcepacks/textures.zip"
cmp "${fixture}/downloads/shaders.zip" "${fixture}/complete-client/overrides/shaderpacks/shaders.zip"
cmp "${fixture}/downloads/datapack.zip" "${fixture}/complete-client/overrides/datapacks/datapack.zip"
cmp "${fixture}/client/overrides/resourcepacks/embedded.zip" "${fixture}/complete-client/overrides/resourcepacks/embedded.zip"
cmp "${fixture}/client/overrides/custom-folder/data.txt" "${fixture}/complete-client/overrides/custom-folder/data.txt"
cmp "${fixture}/client/overrides/config/client.json" "${fixture}/complete-client/overrides/config/client.json"
cmp -- "${fixture}/server/Prominence/mods/one.jar" "${fixture}/resolved/mods/one.jar"
cmp -- "${fixture}/server/Prominence/config/prominence/server.json" \
  "${fixture}/resolved/overrides/config/prominence/server.json"
[[ ! -e "${fixture}/resolved/overrides/start.sh" ]]
[[ ! -e "${fixture}/resolved/overrides/server.properties" ]]

env PATH="${fixture}/bin:${PATH}" CF_API_KEY=test-key FAKE_CF_MODPACK_ROOT="${fixture}" \
  "${resolver}" "${fixture}/source.json" "${fixture}/resolved-again" >/dev/null
cmp "${fixture}/resolved/client.zip" "${fixture}/resolved-again/client.zip"

# A single missing/tampered client dependency refuses the whole release.
printf 'tampered\n' >>"${fixture}/downloads/shaders.zip"
expect_failure "client dependencies must match provider hashes" \
  env PATH="${fixture}/bin:${PATH}" CF_API_KEY=test-key FAKE_CF_MODPACK_ROOT="${fixture}" \
    "${resolver}" "${fixture}/source.json" "${fixture}/partial-client"
[[ ! -e "${fixture}/partial-client" ]]
printf 'shaders\n' >"${fixture}/downloads/shaders.zip"

printf 'tampered mirror\n' >>"${fixture}/downloads/mirror.zip"
expect_failure "mirror must match its pinned SHA-512" \
  env PATH="${fixture}/bin:${PATH}" CF_API_KEY=test-key FAKE_CF_MODPACK_ROOT="${fixture}" \
    "${resolver}" "${fixture}/source.json" "${fixture}/bad-mirror"
[[ ! -e "${fixture}/bad-mirror" ]]
# Restore exactly the original archive bytes for the subsequent checks.
truncate -s "$(jq -r '.client_mirror.bytes' "${fixture}/source.json")" "${fixture}/downloads/mirror.zip"

expect_failure "profile loader pin must match the client manifest" \
  env PATH="${fixture}/bin:${PATH}" CF_API_KEY=test-key FAKE_CF_MODPACK_ROOT="${fixture}" \
    CURSEFORGE_EXPECTED_MINECRAFT_VERSION=1.20.1 CURSEFORGE_EXPECTED_LOADER_TYPE=fabric \
    CURSEFORGE_EXPECTED_LOADER_VERSION=0.0.1 \
    "${resolver}" "${fixture}/source.json" "${fixture}/wrong-loader"

jq '.data.serverPackFileId = 999' "${fixture}/api/9184727.json" >"${fixture}/api/9184727.bad"
mv -- "${fixture}/api/9184727.bad" "${fixture}/api/9184727.json"
expect_failure "main file must bind the pinned server pack" \
  env PATH="${fixture}/bin:${PATH}" CF_API_KEY=test-key FAKE_CF_MODPACK_ROOT="${fixture}" \
    "${resolver}" "${fixture}/source.json" "${fixture}/wrong-relation"

expect_failure "source must pin positive numeric ids" \
  bash -c "jq '.file_id = \"latest\"' '${fixture}/source.json' >'${fixture}/moving.json'; \
    PATH='${fixture}/bin:${PATH}' CF_API_KEY=test-key FAKE_CF_MODPACK_ROOT='${fixture}' \
    '${resolver}' '${fixture}/moving.json' '${fixture}/moving-output'"

printf 'result=passed\n'
