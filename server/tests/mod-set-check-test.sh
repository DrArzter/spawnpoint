#!/usr/bin/env bash

# check-mod-set.sh (ADR-0077) on the other metadata formats: Forge mods.toml
# with Maven ranges and incompatible dependencies, NeoForge and Quilt. The
# modpack-addons test covers Fabric end to end.

set -Eeuo pipefail

repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
check="${repository_root}/server/scripts/check-mod-set.sh"
fixture="$(mktemp -d /tmp/spawnpoint-mod-set-check-test.XXXXXXXX)"
cleanup() {
  rm -rf -- "${fixture}"
}
trap cleanup EXIT

# jar <out> <metadata-path> <metadata> [<extra-path> <extra-content>]
jar() {
  local out="$1" work
  work="$(mktemp -d "${fixture}/jar.XXXXXX")"
  shift
  while (( $# > 0 )); do
    mkdir -p -- "$(dirname -- "${work}/$1")"
    printf '%s\n' "$2" >"${work}/$1"
    shift 2
  done
  (cd "${work}" && zip -qr "${out}" .)
  rm -rf -- "${work}"
}
toml_mod() {
  local id="$1" version="$2" extra="${3:-}"
  printf 'modLoader="javafml"\nloaderVersion="[47,)"\n[[mods]]\nmodId="%s"\nversion="%s"\ndescription='"'''"'\nA [[mods]] line inside a description\n'"'''"'\n%s' \
    "${id}" "${version}" "${extra}"
}
dependency() {
  printf '[[dependencies.%s]]\nmodId="%s"\n%s\nversionRange="%s"\n' "$1" "$2" "$3" "$4"
}

# A case directory: pack/{mods,client.zip}, addons/{both,addons-lock.json}.
case_dir() {
  local directory="${fixture}/$1"
  mkdir -p -- "${directory}/pack/mods" "${directory}/pack/overrides" "${directory}/client/overrides/mods" \
    "${directory}/addons/both" "${directory}/addons/server" "${directory}/addons/client"
  printf '{"manifestType":"minecraftModpack","manifestVersion":1,"version":"1.0","overrides":"overrides","files":[]}\n' \
    >"${directory}/client/manifest.json"
  printf '{"schema_version":1,"files":[]}\n' >"${directory}/client/spawnpoint-client-lock.json"
  printf '%s\n' "${directory}"
}
seal() {
  local directory="$1" file
  cp -- "${directory}/pack/mods/"*.jar "${directory}/client/overrides/mods/"
  (cd "${directory}/client" && zip -qr "${directory}/pack/client.zip" .)
  : >"${directory}/entries"
  for file in "${directory}/addons/both/"*.jar; do
    jq -cn --arg file "$(basename -- "${file}")" --arg sha256 "$(sha256sum "${file}" | awk '{print $1}')" \
      '{name: $file, side: "both", source: {modrinth: {project_id: "Aaaaaaaa", version_id: "Bbbbbbbb"}}, file: $file, sha256: $sha256, bytes: 1}' \
      >>"${directory}/entries"
  done
  jq -s '{schema_version: 1, mods: ., config: null}' "${directory}/entries" >"${directory}/addons/addons-lock.json"
}
run() {
  local directory="$1" loader="$2"
  CHECK_MINECRAFT_VERSION=1.20.1 CHECK_LOADER_TYPE="${loader}" "${check}" "${directory}/pack" "${directory}/addons" \
    >"${fixture}/stdout" 2>"${fixture}/stderr"
}
expect_refusal() {
  local reason="$1"
  grep -Fq -- "${reason}" "${fixture}/stderr" || {
    printf 'missing refusal: %s\n' "${reason}" >&2
    cat "${fixture}/stderr" >&2
    exit 1
  }
}

# --- Forge: a passing addon whose version comes from the JAR manifest ---
forge="$(case_dir forge)"
jar "${forge}/pack/mods/curios-forge-5.4.jar" META-INF/mods.toml "$(toml_mod curios 5.4.0)"
jar "${forge}/pack/mods/jei-15.2.0.27.jar" META-INF/mods.toml "$(toml_mod jei '${file.jarVersion}')" \
  META-INF/MANIFEST.MF $'Manifest-Version: 1.0\nImplementation-Version: 15.2.0.27'
jar "${forge}/addons/both/backpacks-forge.jar" META-INF/mods.toml "$(toml_mod sophisticatedbackpacks 3.26.21 \
  "$(dependency sophisticatedbackpacks minecraft 'mandatory=true' '[1.20.1,1.21)')
$(dependency sophisticatedbackpacks curios 'mandatory=true' '[5,)')
$(dependency sophisticatedbackpacks optionalmod 'mandatory=false' '[1,)')
$(dependency sophisticatedbackpacks jei 'type="incompatible"' '(,15.0)')")"
seal "${forge}"
run "${forge}" forge || { cat "${fixture}/stderr" >&2; exit 1; }
grep -qx 'warnings=0' "${fixture}/stdout"
jq -e 'to_entries | map(.value) | sort == [["curios"], ["jei"], ["sophisticatedbackpacks"]]' "${forge}/addons/mod-index.json" >/dev/null

# --- Forge refusals: wrong Minecraft, a missing mandatory dependency, an incompatible version present ---
forge_bad="$(case_dir forge-bad)"
cp -- "${forge}/pack/mods/"*.jar "${forge_bad}/pack/mods/"
jar "${forge_bad}/addons/both/old.jar" META-INF/mods.toml "$(toml_mod oldmod 1.0 \
  "$(dependency oldmod minecraft 'mandatory=true' '[1.19,1.20)')
$(dependency oldmod missinglib 'mandatory=true' '[1,)')
$(dependency oldmod jei 'type="incompatible"' '[15.0,16.0)')")"
seal "${forge_bad}"
if run "${forge_bad}" forge; then
  printf 'expected refusal: a Forge addon for another Minecraft version\n' >&2
  exit 1
fi
expect_refusal 'C1 addon "old.jar" (old.jar) does not support Minecraft 1.20.1'
expect_refusal 'C6 addon "old.jar" (old.jar) needs missinglib'
expect_refusal 'C7 addon "old.jar": old.jar declares it breaks jei 15.2.0.27'

# --- NeoForge reads neoforge.mods.toml and type="required" ---
neo="$(case_dir neoforge)"
jar "${neo}/pack/mods/curios-neo.jar" META-INF/neoforge.mods.toml "$(toml_mod curios 9.0.0)"
jar "${neo}/addons/both/needs.jar" META-INF/neoforge.mods.toml "$(toml_mod needs 1.0 \
  "$(dependency needs curios 'type="required"' '[9,)')
$(dependency needs ghost 'type="required"' '[1,)')")"
seal "${neo}"
if run "${neo}" neoforge; then
  printf 'expected refusal: a NeoForge addon with a missing required dependency\n' >&2
  exit 1
fi
expect_refusal 'C6 addon "needs.jar" (needs.jar) needs ghost'
if grep -Fq 'needs curios' "${fixture}/stderr"; then
  printf 'curios is in the pack and must satisfy the dependency\n' >&2
  exit 1
fi

# --- Quilt: quilt.mod.json, provides, optional dependencies, and fabric.mod.json as a fallback ---
quilt="$(case_dir quilt)"
jar "${quilt}/pack/mods/qsl.jar" quilt.mod.json '{"schema_version":1,"quilt_loader":{"id":"qsl","version":"6.1.0","provides":["quilted_fabric_api"]}}'
jar "${quilt}/pack/mods/fabric-only.jar" fabric.mod.json '{"schemaVersion":1,"id":"fabriconly","version":"1.0"}'
jar "${quilt}/addons/both/quilt-addon.jar" quilt.mod.json '{"schema_version":1,"quilt_loader":{"id":"quiltaddon","version":"1.0",
  "depends":["quilted_fabric_api",{"id":"fabriconly","versions":">=1.0"},{"id":"nice","optional":true},{"id":"minecraft","versions":"~1.20"}]}}'
seal "${quilt}"
run "${quilt}" quilt || { cat "${fixture}/stderr" >&2; exit 1; }

printf 'mod set check test passed\n'
