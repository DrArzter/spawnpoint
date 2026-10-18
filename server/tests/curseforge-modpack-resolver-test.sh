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
printf '{"manifestType":"minecraftModpack","minecraft":{"version":"1.20.1","modLoaders":[{"id":"fabric-0.19.3","primary":true}]}}\n' \
  >"${fixture}/client/manifest.json"
printf 'client override\n' >"${fixture}/client/README.txt"
(cd "${fixture}/client" && zip -qr "${fixture}/downloads/client.zip" .)
printf 'fabric mod one\n' >"${fixture}/server/Prominence/mods/one.jar"
printf 'fabric mod two\n' >"${fixture}/server/Prominence/mods/two.jar"
printf 'pack config\n' >"${fixture}/server/Prominence/config/prominence/server.json"
printf 'defaults\n' >"${fixture}/server/Prominence/defaultconfigs/game.toml"
printf 'must not execute\n' >"${fixture}/server/Prominence/start.sh"
printf 'must not overwrite operator state\n' >"${fixture}/server/Prominence/server.properties"
(cd "${fixture}/server" && zip -qr "${fixture}/downloads/server.zip" .)

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
jq '.data.downloadUrl = null' "${fixture}/api/9184730.json" >"${fixture}/api/9184730.tmp"
mv -- "${fixture}/api/9184730.tmp" "${fixture}/api/9184730.json"
printf '{"data":"https://downloads.invalid/server.zip"}\n' >"${fixture}/api/9184730-download.json"

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
  */v1/mods/466901/files/*)
    id="${url##*/}"
    source="${FAKE_CF_MODPACK_ROOT}/api/${id}.json"
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

cat >"${fixture}/source.json" <<'EOF'
{"schema_version":1,"project_id":466901,"file_id":9184727,"server_pack_file_id":9184730}
EOF

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
cmp -- "${fixture}/downloads/client.zip" "${fixture}/resolved/client.zip"
cmp -- "${fixture}/server/Prominence/mods/one.jar" "${fixture}/resolved/mods/one.jar"
cmp -- "${fixture}/server/Prominence/config/prominence/server.json" \
  "${fixture}/resolved/overrides/config/prominence/server.json"
[[ ! -e "${fixture}/resolved/overrides/start.sh" ]]
[[ ! -e "${fixture}/resolved/overrides/server.properties" ]]

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
