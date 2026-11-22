#!/usr/bin/env bash

# Addons on top of a CurseForge modpack (ADR-0077), end to end and offline: a
# Prominence-like pack, the unofficial Fabric port of Sophisticated Backpacks
# and Sophisticated Core as Modrinth pins, resolved, checked (C1-C8), built
# into a release and published. CurseForge, the Modrinth CDN and S3 are stubs.

set -Eeuo pipefail

repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
scripts="${repository_root}/server/scripts"
fixture="$(mktemp -d /tmp/spawnpoint-modpack-addons-test.XXXXXXXX)"
cleanup() {
  rm -rf -- "${fixture}"
}
trap cleanup EXIT

# Fails, and for the reason given: a refusal for some other cause is a bug.
refuses() {
  local reason="$1" label="$2"
  shift 2
  if "$@" >/dev/null 2>"${fixture}/stderr"; then
    printf 'expected refusal: %s\n' "${label}" >&2
    exit 1
  fi
  grep -Fq -- "${reason}" "${fixture}/stderr" || {
    printf 'refused for another reason: %s\n' "${label}" >&2
    cat "${fixture}/stderr" >&2
    exit 1
  }
  return 0
}

mkdir -p -- "${fixture}/bin" "${fixture}/api" "${fixture}/downloads" "${fixture}/modrinth" "${fixture}/jars"

# A mod JAR whose only content is its metadata, plus any nested JARs:
# jar <out> <metadata-path> <metadata> [<nested-path> <nested-jar>]...
jar() {
  local out="$1" path="$2" metadata="$3" work
  shift 3
  work="$(mktemp -d "${fixture}/jar.XXXXXX")"
  mkdir -p -- "$(dirname -- "${work}/${path}")"
  printf '%s\n' "${metadata}" >"${work}/${path}"
  while (( $# > 0 )); do
    mkdir -p -- "$(dirname -- "${work}/$1")"
    cp -- "$2" "${work}/$1"
    shift 2
  done
  (cd "${work}" && zip -qr "${out}" .)
  rm -rf -- "${work}"
}
fabric() {
  jar "$1" fabric.mod.json "$2" "${@:3}"
}

# --- the pack's own mods, on both sides ---
J="${fixture}/jars"
fabric "${J}/fabric-transfer-api-v1.jar" '{"schemaVersion":1,"id":"fabric-transfer-api-v1","version":"3.3.5"}'
fabric "${J}/fabric-api-0.92.12+1.20.1.jar" \
  '{"schemaVersion":1,"id":"fabric-api","version":"0.92.12+1.20.1","provides":["fabric"],"jars":[{"file":"META-INF/jars/fabric-transfer-api-v1.jar"}]}' \
  META-INF/jars/fabric-transfer-api-v1.jar "${J}/fabric-transfer-api-v1.jar"
fabric "${J}/ForgeConfigAPIPort-v8.0.3-1.20.1-Fabric.jar" '{"schemaVersion":1,"id":"forgeconfigapiport","version":"8.0.3"}'
fabric "${J}/trinkets-3.7.2.jar" '{"schemaVersion":1,"id":"trinkets","version":"3.7.2","depends":{"minecraft":">=1.20"}}'
fabric "${J}/travelersbackpack-fabric-1.20.1-9.1.55.jar" '{"schemaVersion":1,"id":"travelersbackpack","version":"9.1.55"}'
fabric "${J}/pack-minimap.jar" '{"schemaVersion":1,"id":"pack_minimap","version":"1.0.0","environment":"client"}'
pack_jars=(fabric-api-0.92.12+1.20.1.jar ForgeConfigAPIPort-v8.0.3-1.20.1-Fabric.jar trinkets-3.7.2.jar
  travelersbackpack-fabric-1.20.1-9.1.55.jar)

# --- the modpack: client archive, server pack and their CurseForge records ---
mkdir -p -- "${fixture}/client/overrides/mods" "${fixture}/client/overrides/config" \
  "${fixture}/server/Prominence/mods" "${fixture}/server/Prominence/config"
printf '{"manifestType":"minecraftModpack","manifestVersion":1,"name":"Prominence II","version":"4.1.4","overrides":"overrides","files":[{"projectID":111,"fileID":101}],"minecraft":{"version":"1.20.1","modLoaders":[{"id":"fabric-0.19.3","primary":true}]}}\n' \
  >"${fixture}/client/manifest.json"
for file in "${pack_jars[@]}"; do
  cp -- "${J}/${file}" "${fixture}/client/overrides/mods/"
  cp -- "${J}/${file}" "${fixture}/server/Prominence/mods/"
done
printf 'pack travelers\n' >"${fixture}/client/overrides/config/travelersbackpack.toml"
printf 'pack travelers\n' >"${fixture}/server/Prominence/config/travelersbackpack.toml"
printf 'pack server\n' >"${fixture}/server/Prominence/config/prominence.json"
printf 'switched off\n' >"${fixture}/server/Prominence/mods/sophisticatedbackpacks-1.20.1-old.jar.disabled"
(cd "${fixture}/client" && zip -qr "${fixture}/downloads/client.zip" .)
(cd "${fixture}/server" && zip -qr "${fixture}/downloads/server.zip" .)
cp -- "${J}/pack-minimap.jar" "${fixture}/downloads/pack-minimap.jar"

cf_file() {
  local project="$1" id="$2" file="$3" extra="${4:-}"
  [[ -n "${extra}" ]] || extra='{}'
  local sha
  sha="$(sha1sum "${fixture}/downloads/${file}" | awk '{print $1}')" # NOSONAR test fixture: the fake CurseForge API answers SHA-1, as the real one does
  jq -n --argjson project "${project}" --argjson id "${id}" --arg file "${file}" \
    --argjson bytes "$(stat --format '%s' "${fixture}/downloads/${file}")" \
    --arg sha "${sha}" --argjson extra "${extra}" '
    {data: ({id: $id, modId: $project, fileName: $file, fileLength: $bytes,
      downloadUrl: ("https://downloads.invalid/" + $file), hashes: [{algo: 1, value: $sha}],
      gameVersions: ["1.20.1", "Fabric", "Server", "Client"]} + $extra)}' >"${fixture}/api/file-${id}.json"
}
cf_project() {
  printf '{"data":{"id":%s,"gameId":432,"classId":6%s}}\n' "$1" "${2:-}" >"${fixture}/api/project-$1.json"
}
cf_file 466901 9184727 client.zip '{"serverPackFileId":9184730}'
cf_file 466901 9184730 server.zip '{"parentProjectFileId":9184727}'
cf_file 111 101 pack-minimap.jar
cf_project 111

cat >"${fixture}/bin/curl" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
output= url=
while (( $# > 0 )); do
  case "$1" in
    -o) output="$2"; shift 2 ;;
    -H | --proto | --retry | --connect-timeout | --max-time) shift 2 ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
printf '%s\n' "${url}" >>"${FAKE_ROOT}/curl.log"
case "${url}" in
  */v1/mods/*/files/*) [[ "${CF_API_KEY:-}" == test-key ]]; source="${FAKE_ROOT}/api/file-${url##*/}.json" ;;
  */v1/mods/*) [[ "${CF_API_KEY:-}" == test-key ]]; source="${FAKE_ROOT}/api/project-${url##*/}.json" ;;
  https://cdn.modrinth.com/data/*)
    rest="${url#https://cdn.modrinth.com/data/}"
    IFS=/ read -r _project _versions version file <<<"${rest}"
    source="${FAKE_ROOT}/modrinth/${version}/${file//%2B/+}"
    ;;
  https://downloads.invalid/*) source="${FAKE_ROOT}/downloads/${url##*/}" ;;
  *) exit 22 ;;
esac
[[ -f "${source}" ]] || exit 22
if [[ -n "${output}" ]]; then cp -- "${source}" "${output}"; else cat -- "${source}"; fi
EOF
chmod 0755 "${fixture}/bin/curl"
ln -s -- "${repository_root}/server/tests/fake-aws" "${fixture}/bin/aws"
export PATH="${fixture}/bin:${PATH}"
export CF_API_KEY=test-key
export FAKE_ROOT="${fixture}"
export FAKE_S3_ROOT="${fixture}/s3"
export RELEASE_BUCKET="spawnpoint-test-releases"

# --- the worked example: the unofficial Fabric port, as published on Modrinth ---
porting_lib() {
  fabric "${J}/porting_lib_$1.jar" "{\"schemaVersion\":1,\"id\":\"porting_lib_$1\",\"version\":\"2.3.2+1.20.1\",\"depends\":{\"fabric\":\">=0.91.0+1.20.1\",\"minecraft\":\"=1.20.1\"}}"
}
nested=()
for module in extensions fluids loot model_loader networking tool_actions transfer; do
  porting_lib "${module}"
  nested+=("META-INF/jars/${module}-2.3.2+1.20.1.jar" "${J}/porting_lib_${module}.jar")
done
fabric "${J}/energy.jar" '{"schemaVersion":1,"id":"team_reborn_energy","version":"3.0.0","depends":{"fabric-transfer-api-v1":">=3.0.1"}}'
fabric "${J}/mixinextras.jar" '{"schemaVersion":1,"id":"mixinextras","version":"0.3.5","provides":["com_github_llamalad7_mixinextras"]}'
nested+=(META-INF/jars/energy-3.0.0.jar "${J}/energy.jar" META-INF/jars/mixinextras-fabric-0.3.5.jar "${J}/mixinextras.jar")
core_file=sophisticatedcore-1.20.1-1.2.7.15.166.jar
backpacks_file=sophisticatedbackpacks-1.20.1-3.23.4.5.110.jar
mkdir -p -- "${fixture}/modrinth/BP3CQI2v" "${fixture}/modrinth/Jk6o7s4h"
fabric "${fixture}/modrinth/BP3CQI2v/${core_file}" '{"schemaVersion":1,"id":"sophisticatedcore","version":"1.20.1-1.2.7.15.166",
  "depends":{"minecraft":"1.20.1","fabricloader":">=0.16.9","fabric-api":">=0.92.2+1.20.1","porting_lib_extensions":">=2.3.2",
    "porting_lib_fluids":">=2.3.2","porting_lib_networking":">=2.3.2","porting_lib_transfer":">=2.3.2",
    "forgeconfigapiport":">=8.0.0","team_reborn_energy":">=3.0.0"},
  "breaks":{"jei":"<15.20.0.105"},
  "jars":[{"file":"META-INF/jars/energy-3.0.0.jar"},{"file":"META-INF/jars/extensions-2.3.2+1.20.1.jar"},
    {"file":"META-INF/jars/fluids-2.3.2+1.20.1.jar"},{"file":"META-INF/jars/loot-2.3.2+1.20.1.jar"},
    {"file":"META-INF/jars/mixinextras-fabric-0.3.5.jar"},{"file":"META-INF/jars/model_loader-2.3.2+1.20.1.jar"},
    {"file":"META-INF/jars/networking-2.3.2+1.20.1.jar"},{"file":"META-INF/jars/tool_actions-2.3.2+1.20.1.jar"},
    {"file":"META-INF/jars/transfer-2.3.2+1.20.1.jar"}]}' "${nested[@]}"
fabric "${fixture}/modrinth/Jk6o7s4h/${backpacks_file}" '{"schemaVersion":1,"id":"sophisticatedbackpacks","version":"1.20.1-3.23.4.5.110",
  "depends":{"fabricloader":">=0.16.9","fabric-api":">=0.92.2+1.20.1","minecraft":"1.20.1",
    "sophisticatedcore":">=1.20.1-1.2.7.7 <1.20.4","forgeconfigapiport":">=8.0.0","team_reborn_energy":">=3.0.0",
    "porting_lib_loot":">=2.3.2","porting_lib_model_loader":">=2.3.2","porting_lib_tool_actions":">=2.3.2",
    "porting_lib_networking":">=2.3.2","porting_lib_transfer":">=2.3.2"}}'

# A Modrinth pin of a file the fake CDN serves: modrinth <project> <version> <file> [side] [name]
modrinth() {
  local project="$1" version="$2" file="$3" side="${4:-both}" name="${5:-$3}" path="${fixture}/modrinth/$2/$3"
  jq -cn --arg name "${name}" --arg side "${side}" --arg project "${project}" --arg version "${version}" --arg file "${file}" \
    --arg sha512 "$(sha512sum "${path}" | awk '{print $1}')" --argjson bytes "$(stat --format '%s' "${path}")" \
    '{name: $name, side: $side, modrinth: {project_id: $project, version_id: $version, file: $file, sha512: $sha512, bytes: $bytes}}'
}
modrinth_jar() {
  local version="$1" file="$2" metadata="$3"
  mkdir -p -- "${fixture}/modrinth/${version}"
  fabric "${fixture}/modrinth/${version}/${file}" "${metadata}"
}
backpacks="$(modrinth ouNrBQtq Jk6o7s4h "${backpacks_file}" both "Sophisticated Backpacks (unofficial Fabric port)")"
core="$(modrinth 9jxwkYQL BP3CQI2v "${core_file}" both "Sophisticated Core (unofficial Fabric port)" |
  jq -c '.required_by = ["Sophisticated Backpacks (unofficial Fabric port)"]')"

# --- the config repository ---
config="${fixture}/config"
git -C "${fixture}" init --quiet config
git -C "${config}" remote add origin https://github.com/example/minecraft-config.git
jq -n '{schema_version:1,project_id:466901,file_id:9184727,server_pack_file_id:9184730}' >"${fixture}/pack.json"
# profile <id> [addons-json]: Prominence's pins, with addons when given.
profile() {
  local id="$1" addons="${2:-}" directory="${config}/profiles/$1"
  mkdir -p -- "${directory}/extras"
  cp -- "${fixture}/pack.json" "${directory}/extras/curseforge-modpack.json"
  jq -n --arg id "${id}" --arg addons "${addons}" '{schema_version:1,id:$id,minecraft_version:"1.20.1",
    loader:{type:"fabric",version:"0.19.3"},
    mods:({source:"extras/curseforge-modpack.json",resolver:"curseforge-modpack"} +
      if $addons == "" then {} else {addons:"extras/addons.json"} end)}' >"${directory}/profile.json"
  [[ -z "${addons}" ]] || jq . <<<"${addons}" >"${directory}/extras/addons.json"
}
addons() {
  jq -cn --argjson mods "$1" --argjson config "${2:-null}" \
    '{schema_version:1,mods:$mods} + if $config == null then {} else {config:$config} end'
}

profile prominence "$(addons "[${backpacks},${core}]" \
  '{"tree":"addons-config","replaces":["config/travelersbackpack.toml"]}')"
tree="${config}/profiles/prominence/addons-config"
mkdir -p -- "${tree}/config" "${tree}/client/config"
printf 'addon common\n' >"${tree}/config/sophisticatedbackpacks-common.toml"
printf 'addon travelers\n' >"${tree}/config/travelersbackpack.toml"
printf 'addon client\n' >"${tree}/client/config/sophisticatedbackpacks-client.toml"
profile pure

# Sides: a client-only Modrinth addon and a server-only CurseForge addon.
modrinth_jar Mm000001 zoomify-2.11.jar '{"schemaVersion":1,"id":"zoomify","version":"2.11","depends":{"minecraft":"1.20.x","fabric-api":"*"}}'
fabric "${fixture}/downloads/spark-1.10.53-fabric.jar" '{"schemaVersion":1,"id":"spark","version":"1.10.53","depends":{"fabric-api":"*"}}'
cf_file 555 5001 spark-1.10.53-fabric.jar
cf_project 555 ',"allowModDistribution":true'
profile sides "$(addons "[$(modrinth Zz000001 Mm000001 zoomify-2.11.jar client Zoomify),
  {\"name\":\"spark\",\"side\":\"server\",\"curseforge\":{\"project_id\":555,\"file_id\":5001}}]")"

git -C "${config}" add -A
git -C "${config}" -c user.name=Test -c user.email=test@example.invalid commit --quiet -m profiles

# --- the dry build of the worked example ---
payload="${fixture}/prominence"
output="$("${scripts}/resolve-profile-mods.sh" "${config}/profiles/prominence" "${payload}/mods" 2>"${fixture}/resolve.log")"
grep -qx 'addons=2' <<<"${output}"
grep -qx 'mods=6' <<<"${output}"
# C5 warns about the switched-off JAR; C4 about Porting Lib nested in two places is not expected here.
grep -Fq 'warning: C5 addon "Sophisticated Backpacks (unofficial Fabric port)" matches sophisticatedbackpacks-1.20.1-old.jar.disabled' \
  "${fixture}/resolve.log"
# Modrinth bytes came from the CDN path of each pinned version, nothing else.
grep -Fxq "https://cdn.modrinth.com/data/ouNrBQtq/versions/Jk6o7s4h/${backpacks_file}" "${fixture}/curl.log"
grep -Fxq "https://cdn.modrinth.com/data/9jxwkYQL/versions/BP3CQI2v/${core_file}" "${fixture}/curl.log"

files() {
  find "$1" -maxdepth 1 -type f -name '*.jar' -printf '%f\n' | LC_ALL=C sort | paste -sd ' ' -
}
# The server set: the pack's JARs plus both addons; the pack config with the addon tree over it.
[[ "$(files "${payload}/mods")" == "ForgeConfigAPIPort-v8.0.3-1.20.1-Fabric.jar fabric-api-0.92.12+1.20.1.jar ${backpacks_file} ${core_file} travelersbackpack-fabric-1.20.1-9.1.55.jar trinkets-3.7.2.jar" ]]
[[ "$(cat "${payload}/overrides/config/travelersbackpack.toml")" == "addon travelers" ]]
[[ "$(cat "${payload}/overrides/config/sophisticatedbackpacks-common.toml")" == "addon common" ]]
[[ "$(cat "${payload}/overrides/config/prominence.json")" == "pack server" ]]
[[ ! -e "${payload}/overrides/config/sophisticatedbackpacks-client.toml" && ! -e "${payload}/overrides/client" ]]
[[ ! -e "${payload}/client.zip" && ! -e "${payload}/client-mods" ]]

output="$("${scripts}/build-profile-release.sh" "${config}/profiles/prominence" 1.0 "${payload}/mods" "${payload}/manifest.json")"
manifest="${payload}/manifest.json"
jq -e --arg backpacks "${backpacks_file}" --arg core "${core_file}" '
  (.server.mods | map({key: .file, value: .}) | from_entries) as $server |
  .client.kind == "curseforge-modpack" and .client.file == "client.zip" and
  ([.client.addons[] | [.file, .side]] == [[$backpacks, "both"], [$core, "both"]]) and
  all(.client.addons[]; $server[.file].sha256 == .sha256 and $server[.file].bytes == .bytes)
' "${manifest}" >/dev/null
# mod_index: every server file by digest, the addons by their own ids.
jq -e --arg backpacks "${backpacks_file}" '
  (.mod_index | keys) == ([.server.mods[].sha256] | unique) and
  (.server.mods[] | select(.file == $backpacks) | .sha256) as $digest | .mod_index[$digest] == ["sophisticatedbackpacks"]
' "${manifest}" >/dev/null
jq -e 'any(.mod_index[]; . == ["fabric", "fabric-api"])' "${manifest}" >/dev/null

# The client pack: one import with the addons and their config inside.
client_tree="${fixture}/client-tree"
mkdir -p -- "${client_tree}"
unzip -q "${payload}/client.zip" -d "${client_tree}"
jq -e '.version == "4.1.4+1.0" and .files == [] and .minecraft.modLoaders[0].id == "fabric-0.19.3"' \
  "${client_tree}/manifest.json" >/dev/null
cmp -- "${fixture}/modrinth/Jk6o7s4h/${backpacks_file}" "${client_tree}/overrides/mods/${backpacks_file}"
cmp -- "${fixture}/modrinth/BP3CQI2v/${core_file}" "${client_tree}/overrides/mods/${core_file}"
cmp -- "${J}/pack-minimap.jar" "${client_tree}/overrides/mods/pack-minimap.jar"
[[ "$(cat "${client_tree}/overrides/config/travelersbackpack.toml")" == "addon travelers" ]]
[[ "$(cat "${client_tree}/overrides/config/sophisticatedbackpacks-client.toml")" == "addon client" ]]
[[ "$(cat "${client_tree}/overrides/config/sophisticatedbackpacks-common.toml")" == "addon common" ]]
jq -e --arg backpacks "${backpacks_file}" '
  (.files | length) == 1 and
  ([.addons[] | .path] == ["mods/" + $backpacks, "mods/sophisticatedcore-1.20.1-1.2.7.15.166.jar"]) and
  (.addons[0].source == {modrinth: {project_id: "ouNrBQtq", version_id: "Jk6o7s4h"}})
' "${client_tree}/spawnpoint-client-lock.json" >/dev/null
[[ "$(jq -r '.client.sha256' "${manifest}")" == "$(sha256sum "${payload}/client.zip" | awk '{print $1}')" ]]

# Publication: the pack as built, no server or full pack for a modpack, no client-mods.
output="$(RELEASE_SOURCE_DIR="${payload}" "${scripts}/upload-release.sh" "${manifest}")"
grep -qx 'result=uploaded' <<<"${output}"
grep -qx 'mods=6' <<<"${output}"
grep -qx 'server_pack=not_applicable' <<<"${output}"
release="${FAKE_S3_ROOT}/${RELEASE_BUCKET}/releases/minecraft/prominence/1.0"
cmp -- "${payload}/client.zip" "${release}/client.zip"
cmp -- "${fixture}/modrinth/Jk6o7s4h/${backpacks_file}" "${release}/mods/${backpacks_file}"
[[ ! -e "${release}/client-mods" ]]
# mod_index is descriptive: another index is the same release, another addon is not.
jq '.mod_index = {} | .created_at = "2000-01-01T00:00:00Z"' "${manifest}" >"${fixture}/reindexed.json"
grep -qx 'result=already_present' <<<"$(RELEASE_SOURCE_DIR="${payload}" "${scripts}/upload-release.sh" "${fixture}/reindexed.json")"
jq '.client.addons |= map(select(.file != "sophisticatedcore-1.20.1-1.2.7.15.166.jar"))' "${manifest}" >"${fixture}/fewer.json"
refuses "already exists with different content" "the same release with another addon set" \
  env RELEASE_SOURCE_DIR="${payload}" "${scripts}/upload-release.sh" "${fixture}/fewer.json"

# --- a modpack without addons builds exactly as before: no mod_index, no client.addons ---
"${scripts}/resolve-profile-mods.sh" "${config}/profiles/pure" "${fixture}/pure/mods" >/dev/null 2>&1
[[ -f "${fixture}/pure/client.zip" && ! -e "${fixture}/pure/addons" ]]
"${scripts}/build-profile-release.sh" "${config}/profiles/pure" 1.0 "${fixture}/pure/mods" "${fixture}/pure/manifest.json" >/dev/null
jq -e '(has("mod_index") | not) and (.client | keys) == ["bytes", "file", "kind", "sha256"]' "${fixture}/pure/manifest.json" >/dev/null
[[ "$(unzip -p "${fixture}/pure/client.zip" manifest.json | jq -r '.version')" == "4.1.4" ]]

# --- sides: a client-only addon reaches players only, a server-only addon the server only ---
output="$("${scripts}/resolve-profile-mods.sh" "${config}/profiles/sides" "${fixture}/sides/mods" 2>/dev/null)"
grep -qx 'client_mods=1' <<<"${output}"
[[ "$(files "${fixture}/sides/client-mods")" == "zoomify-2.11.jar" ]]
[[ -f "${fixture}/sides/mods/spark-1.10.53-fabric.jar" && ! -e "${fixture}/sides/mods/zoomify-2.11.jar" ]]
"${scripts}/build-profile-release.sh" "${config}/profiles/sides" 2.0 "${fixture}/sides/mods" "${fixture}/sides/manifest.json" >/dev/null
jq -e '[.client.addons[] | [.file, .side]] == [["spark-1.10.53-fabric.jar", "server"], ["zoomify-2.11.jar", "client"]]' \
  "${fixture}/sides/manifest.json" >/dev/null
sides_pack="$(unzip -Z1 "${fixture}/sides/client.zip")"
grep -Fxq overrides/mods/zoomify-2.11.jar <<<"${sides_pack}"
if grep -Fq spark <<<"${sides_pack}"; then
  printf 'a server-only addon reached the client pack\n' >&2
  exit 1
fi
output="$(RELEASE_SOURCE_DIR="${fixture}/sides" "${scripts}/upload-release.sh" "${fixture}/sides/manifest.json")"
grep -qx 'client_mods=1' <<<"${output}"
sides_release="${FAKE_S3_ROOT}/${RELEASE_BUCKET}/releases/minecraft/sides/2.0"
[[ "$(files "${sides_release}/client-mods")" == "zoomify-2.11.jar" ]]
[[ -f "${sides_release}/mods/spark-1.10.53-fabric.jar" ]]
jq '.client.addons[1].file = "spark-1.10.53-fabric.jar" | .client.addons[1].side = "client"' \
  "${fixture}/sides/manifest.json" >"${fixture}/client-named-like-server.json"
refuses "invalid release manifest" "a client addon under a server mod's name" \
  env RELEASE_SOURCE_DIR="${fixture}/sides" "${scripts}/upload-release.sh" "${fixture}/client-named-like-server.json"

# --- refusals: one profile per rule ---
refusal() {
  local id="$1" reason="$2" label="$3"
  refuses "${reason}" "${label}" "${scripts}/resolve-profile-mods.sh" "${config}/profiles/${id}" "${fixture}/${id}/mods"
  [[ ! -e "${fixture}/${id}/mods" && ! -e "${fixture}/${id}/addons" && ! -e "${fixture}/${id}/overrides" ]]
}
# C1: the official Sophisticated Backpacks is a Forge mod.
mkdir -p -- "${fixture}/modrinth/Ff000001"
jar "${fixture}/modrinth/Ff000001/sophisticatedbackpacks-1.20.1-3.26.21.jar" META-INF/mods.toml \
  $'modLoader="javafml"\n[[mods]]\nmodId="sophisticatedbackpacks"\n[[dependencies.sophisticatedbackpacks]]\nmodId="minecraft"\nmandatory=true\nversionRange="[1.20.1,1.21)"'
profile c1-forge "$(addons "[$(modrinth TyCTlI4b Ff000001 sophisticatedbackpacks-1.20.1-3.26.21.jar)]")"
modrinth_jar Mc000001 old-mod-1.19.jar '{"schemaVersion":1,"id":"oldmod","version":"1.0","depends":{"minecraft":"~1.19.2"}}'
profile c1-minecraft "$(addons "[$(modrinth Pc000001 Mc000001 old-mod-1.19.jar)]")"
# C2: a file the pack already has.
mkdir -p -- "${fixture}/modrinth/Tb000001"
cp -- "${J}/trinkets-3.7.2.jar" "${fixture}/modrinth/Tb000001/"
profile c2 "$(addons "[$(modrinth Pt000001 Tb000001 trinkets-3.7.2.jar)]")"
# C3: a CurseForge project the pack resolves.
profile c3 "$(addons '[{"name":"Pack minimap again","side":"client","curseforge":{"project_id":111,"file_id":101}}]')"
# C4: another JAR of a mod the pack has.
modrinth_jar Tr000001 travelersbackpack-other.jar '{"schemaVersion":1,"id":"travelersbackpack","version":"9.2.0"}'
profile c4 "$(addons "[$(modrinth Ptr00001 Tr000001 travelersbackpack-other.jar)]")"
# C6: Backpacks without Core.
profile c6 "$(addons "[${backpacks}]")"
# C7: an addon that declares it breaks a pack mod.
modrinth_jar Br000001 breaker.jar '{"schemaVersion":1,"id":"breaker","version":"1.0","breaks":{"trinkets":"<4"}}'
profile c7 "$(addons "[$(modrinth Pbr00001 Br000001 breaker.jar)]")"
# C8: a client addon that needs a server-only addon.
modrinth_jar Cl000001 hud.jar '{"schemaVersion":1,"id":"hud","version":"1.0","depends":{"serverlib":"*"}}'
modrinth_jar Sv000001 serverlib.jar '{"schemaVersion":1,"id":"serverlib","version":"1.0"}'
profile c8 "$(addons "[$(modrinth Pcl00001 Cl000001 hud.jar client), $(modrinth Psv00001 Sv000001 serverlib.jar server)]")"
# Distribution switched off by the author, and no mirror.
fabric "${fixture}/downloads/locked-1.0.jar" '{"schemaVersion":1,"id":"locked","version":"1.0"}'
cf_file 556 5002 locked-1.0.jar '{"downloadUrl":null}'
cf_project 556 ',"allowModDistribution":false'
profile distribution "$(addons '[{"name":"Locked","side":"both","curseforge":{"project_id":556,"file_id":5002}}]')"
# Bytes that are not the pinned bytes.
profile tampered "$(addons "[$(jq -c '.modrinth.bytes += 1' <<<"${core}"), ${backpacks}]")"
# config: an overwrite not named, and a name that overwrites nothing.
profile config-unnamed "$(addons "[${backpacks},${core}]" '{"tree":"addons-config","replaces":[]}')"
mkdir -p -- "${config}/profiles/config-unnamed/addons-config/config"
printf 'other\n' >"${config}/profiles/config-unnamed/addons-config/config/travelersbackpack.toml"
profile config-stale "$(addons "[${backpacks},${core}]" '{"tree":"addons-config","replaces":["config/gone.toml"]}')"
mkdir -p -- "${config}/profiles/config-stale/addons-config/config"
printf 'other\n' >"${config}/profiles/config-stale/addons-config/config/gone.toml"
profile config-root "$(addons "[${backpacks},${core}]" '{"tree":"addons-config","replaces":[]}')"
mkdir -p -- "${config}/profiles/config-root/addons-config/mods"
printf 'not config\n' >"${config}/profiles/config-root/addons-config/mods/extra.jar"
# An unpinned entry, side lists beside addons, and addons on a files preset.
profile unpinned "$(addons '[{"name":"Latest","side":"both","modrinth":{"project_id":"ouNrBQtq","version_id":"latest00"}}]')"
profile side-lists "$(addons "[${backpacks},${core}]")"
jq '.mods.client_only = "client-only.txt"' "${config}/profiles/side-lists/profile.json" >"${fixture}/p.json"
mv -- "${fixture}/p.json" "${config}/profiles/side-lists/profile.json"
printf 'minimap\n' >"${config}/profiles/side-lists/client-only.txt"
profile files-preset "$(addons "[${backpacks},${core}]")"
jq '.mods.resolver = "curseforge-files"' "${config}/profiles/files-preset/profile.json" >"${fixture}/p.json"
mv -- "${fixture}/p.json" "${config}/profiles/files-preset/profile.json"
git -C "${config}" add -A
git -C "${config}" -c user.name=Test -c user.email=test@example.invalid commit --quiet -m refusals

refusal c1-forge "C1 addon" "a Forge JAR on a Fabric pack"
grep -Fq "has no readable fabric mod metadata" "${fixture}/stderr"
refusal c1-minecraft "does not support Minecraft 1.20.1" "a JAR for another Minecraft version"
refusal c2 "C2 addon" "a file the pack already has"
grep -Fq "the pack already has trinkets-3.7.2.jar" "${fixture}/stderr"
refusal c3 "C3 addon \"Pack minimap again\": the pack already has CurseForge project 111" "a CurseForge project the pack has"
refusal c4 "C4 addon" "a mod id the pack already has"
grep -Fq "the pack already has mod travelersbackpack" "${fixture}/stderr"
refusal c6 "C6 addon \"Sophisticated Backpacks (unofficial Fabric port)\"" "an unmet required dependency"
grep -Fq "needs sophisticatedcore" "${fixture}/stderr"
refusal c7 "C7 addon" "a declared breaks that matches"
grep -Fq "breaks trinkets 3.7.2" "${fixture}/stderr"
refusal c8 "C8 addon \"hud.jar\" needs serverlib on the client side" "a client addon needing a server-only addon"
refusal distribution "disables third-party distribution" "a CurseForge file the author does not let others distribute"
refusal tampered "does not match the pinned SHA-512 and size" "Modrinth bytes that differ from the pin"
refusal config-unnamed "overwrites pack file config/travelersbackpack.toml; name it in config.replaces" "an unnamed config overwrite"
refusal config-stale "names config/gone.toml, which the pack does not have" "a replaces entry the pack does not have"
refusal config-root "outside the allowed roots: mods/extra.jar" "a config tree file outside the allowed roots"
refusal unpinned "invalid addons file" "an entry without an exact file pin"
refusal side-lists "invalid profile metadata" "ADR-0069 side lists beside addons"
refusal files-preset "invalid profile metadata" "addons on a preset of CurseForge files"

# --- world_data (ADR-0077): paths the world owns inside the managed roots ---
spark_entry='{"name":"spark","side":"server","curseforge":{"project_id":555,"file_id":5001}}'
profile world-data "$(addons "[$(jq -c '.world_data = ["config/spark/data"]' <<<"${spark_entry}")]")"
profile world-data-overlap "$(addons "[$(jq -c '.world_data = ["config/spark"]' <<<"${spark_entry}")]" \
  '{"tree":"addons-config","replaces":[]}')"
mkdir -p -- "${config}/profiles/world-data-overlap/addons-config/config/spark"
printf 'shipped\n' >"${config}/profiles/world-data-overlap/addons-config/config/spark/settings.toml"
profile world-data-root "$(addons "[$(jq -c '.world_data = ["config"]' <<<"${spark_entry}")]")"
profile world-data-client "$(addons "[$(jq -c '.side = "client" | .world_data = ["config/spark/data"]' <<<"${spark_entry}")]")"
profile world-data-nested "$(addons "[$(jq -c '.world_data = ["config/spark", "config/spark/data"]' <<<"${spark_entry}")]")"
git -C "${config}" add -A
git -C "${config}" -c user.name=Test -c user.email=test@example.invalid commit --quiet -m world-data

"${scripts}/resolve-profile-mods.sh" "${config}/profiles/world-data" "${fixture}/world-data/mods" >/dev/null 2>&1
output="$("${scripts}/build-profile-release.sh" "${config}/profiles/world-data" 1.0 "${fixture}/world-data/mods" "${fixture}/world-data/manifest.json")"
grep -qx 'world_data=1' <<<"${output}"
jq -e '.server.world_data == ["config/spark/data"]' "${fixture}/world-data/manifest.json" >/dev/null
# A release without world_data carries no key, so its identity is unchanged.
jq -e '.server | has("world_data") | not' "${fixture}/pure/manifest.json" >/dev/null
"${scripts}/resolve-profile-mods.sh" "${config}/profiles/world-data-overlap" "${fixture}/world-data-overlap/mods" >/dev/null 2>&1
refuses "a world_data path overlaps a file the release ships: config/spark and config/spark/settings.toml" \
  "a world_data path over a shipped config file" \
  "${scripts}/build-profile-release.sh" "${config}/profiles/world-data-overlap" 1.0 \
    "${fixture}/world-data-overlap/mods" "${fixture}/world-data-overlap/manifest.json"
refusal world-data-root "invalid addons file" "a whole managed root as world_data"
refusal world-data-client "invalid addons file" "world_data on a client addon"
refusal world-data-nested "invalid addons file" "one world_data path inside another"
# The host refuses the same overlap in a manifest that did not come from the build.
jq '.server.world_data = ["config/prominence.json"]' "${manifest}" >"${fixture}/world-data-forged.json"
refuses "invalid release manifest" "a forged manifest with world_data over a shipped file" \
  env RELEASE_SOURCE_DIR="${payload}" "${scripts}/upload-release.sh" "${fixture}/world-data-forged.json"

# The distribution rule allows the same bytes from a reviewed mirror.
mirror_entry="$(jq -cn --arg sha512 "$(sha512sum "${fixture}/downloads/locked-1.0.jar" | awk '{print $1}')" \
  --argjson bytes "$(stat --format '%s' "${fixture}/downloads/locked-1.0.jar")" \
  '{name:"Locked",side:"both",curseforge:{project_id:556,file_id:5002,
    mirror:{url:"https://downloads.invalid/locked-1.0.jar",sha512:$sha512,bytes:$bytes}}}')"
addons "[${mirror_entry}]" >"${fixture}/mirror-addons.json"
ADDONS_MINECRAFT_VERSION=1.20.1 ADDONS_LOADER_TYPE=fabric \
  "${scripts}/resolve-addons.sh" "${fixture}/mirror-addons.json" "${fixture}" "${fixture}/mirror-out" >/dev/null
jq -e '.mods[0].source == {curseforge: {project_id: 556, file_id: 5002}}' "${fixture}/mirror-out/addons-lock.json" >/dev/null
# A CurseForge file not published for this loader is refused at the source (C1).
cf_file 557 5003 locked-1.0.jar '{"gameVersions":["1.20.1","Forge"]}'
cf_project 557 ',"allowModDistribution":true'
addons '[{"name":"Forge only","side":"both","curseforge":{"project_id":557,"file_id":5003}}]' >"${fixture}/forge-only.json"
refuses "C1 addon \"Forge only\": CurseForge file 5003 is not published for Minecraft 1.20.1 on Fabric" "a CurseForge file for another loader" \
  env ADDONS_MINECRAFT_VERSION=1.20.1 ADDONS_LOADER_TYPE=fabric \
    "${scripts}/resolve-addons.sh" "${fixture}/forge-only.json" "${fixture}" "${fixture}/forge-only-out"

# The sample under docs is valid and names the real CDN files. This test serves
# its own fixture bytes there, which the real pins must refuse.
: >"${fixture}/curl.log"
refuses "does not match the pinned SHA-512 and size" "the docs sample against this test's own bytes" \
  env ADDONS_MINECRAFT_VERSION=1.20.1 ADDONS_LOADER_TYPE=fabric \
    "${scripts}/resolve-addons.sh" "${repository_root}/docs/examples/prominence-addons/addons.json" "${fixture}" "${fixture}/sample"
grep -Fxq "https://cdn.modrinth.com/data/ouNrBQtq/versions/Jk6o7s4h/${backpacks_file}" "${fixture}/curl.log"
jq -e '[.mods[].modrinth | {version_id, bytes}] == [{version_id: "Jk6o7s4h", bytes: 986101}, {version_id: "BP3CQI2v", bytes: 2858683}]' \
  "${repository_root}/docs/examples/prominence-addons/addons.json" >/dev/null

printf 'modpack addons test passed\n'
