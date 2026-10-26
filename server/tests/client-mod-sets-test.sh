#!/usr/bin/env bash

# A preset's side lists (ADR-0069): the server runs source + server_only,
# players install source + client_only. Resolved, recorded and published end to
# end, with a resolver stub that turns each list line into its own jar.

set -Eeuo pipefail

repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
scripts="${repository_root}/server/scripts"
fixture="$(mktemp -d /tmp/spawnpoint-client-mod-sets-test.XXXXXXXX)"
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

# --- mc-image-helper stub: line "name" resolves to name.jar holding "jar name";
#     "name=bytes" gives it other bytes ---
mkdir -p -- "${fixture}/bin"
cat >"${fixture}/bin/docker" <<'EOF'
#!/usr/bin/env bash
profile= output= listing= previous=
for argument in "$@"; do
  [[ "${previous}" == "--volume" && "${argument}" == *:/profile:ro ]] && profile="${argument%:/profile:ro}"
  [[ "${previous}" == "--volume" && "${argument}" == *:/output ]] && output="${argument%:/output}"
  [[ "${argument}" == @/profile/* ]] && listing="${argument#@/profile/}"
  previous="${argument}"
done
[[ -n "${profile}" && -n "${output}" && -n "${listing}" ]] || exit 90
mkdir -p -- "${output}/mods"
while IFS= read -r line; do
  [[ -n "${line}" ]] || continue
  name="${line%%=*}"
  bytes="${line#*=}"
  [[ "${line}" == *=* ]] || bytes="${name}"
  printf 'jar %s\n' "${bytes}" >"${output}/mods/${name}.jar"
done <"${profile}/${listing}"
EOF
chmod 0755 "${fixture}/bin/docker"
ln -s -- "${repository_root}/server/tests/fake-aws" "${fixture}/bin/aws"
export PATH="${fixture}/bin:${PATH}"
export CF_API_KEY='$2a$10$test-only-not-a-secret'
export FAKE_S3_ROOT="${fixture}/s3"
export RELEASE_BUCKET="spawnpoint-test-releases"

config="${fixture}/config"
git -C "${fixture}" init --quiet config
git -C "${config}" remote add origin https://github.com/example/minecraft-config.git
profile() {
  local id="$1" mods="$2"
  mkdir -p -- "${config}/profiles/${id}"
  printf '{"schema_version":1,"id":"%s","minecraft_version":"1.20.1","loader":{"type":"forge","version":"47.4.10"},"mods":%s}\n' \
    "${id}" "${mods}" >"${config}/profiles/${id}/profile.json"
}
list() {
  local id="$1" name="$2"
  shift 2
  printf '%s\n' "$@" >"${config}/profiles/${id}/${name}"
}
commit() {
  git -C "${config}" add -A
  git -C "${config}" -c user.name=Test -c user.email=test@example.invalid commit --quiet -m profiles
}

profile sides '{"source":"mods.txt","server_only":"server-only.txt","client_only":"client-only.txt"}'
list sides mods.txt shared lib
list sides server-only.txt spark
# lib again: a dependency the client mod shares with the source, kept once.
list sides client-only.txt minimap lib
profile plain '{"source":"mods.txt"}'
list plain mods.txt shared
profile conflict '{"source":"mods.txt","client_only":"client-only.txt"}'
list conflict mods.txt shared
list conflict client-only.txt shared=other
profile nothing-new '{"source":"mods.txt","client_only":"client-only.txt"}'
list nothing-new mods.txt shared
list nothing-new client-only.txt shared
profile modpack '{"source":"pack.json","resolver":"curseforge-modpack","client_only":"client-only.txt"}'
list modpack pack.json '{}'
list modpack client-only.txt minimap
profile without-source '{"source":null,"client_only":"client-only.txt"}'
list without-source client-only.txt minimap
commit

files() {
  find "$1" -maxdepth 1 -type f -name '*.jar' -printf '%f\n' | sort | paste -sd ' ' -
}

# --- resolution: the server set and the players set, side by side ---
output="$("${scripts}/resolve-profile-mods.sh" "${config}/profiles/sides" "${fixture}/sides/mods")"
grep -qx 'mods=3' <<<"${output}"
grep -qx 'client_mods=3' <<<"${output}"
[[ "$(files "${fixture}/sides/mods")" == "lib.jar shared.jar spark.jar" ]]
[[ "$(files "${fixture}/sides/client-mods")" == "lib.jar minimap.jar shared.jar" ]]

# --- the manifest records both sets ---
"${scripts}/build-profile-release.sh" "${config}/profiles/sides" 1.0 \
  "${fixture}/sides/mods" "${fixture}/sides/manifest.json" >/dev/null
manifest="${fixture}/sides/manifest.json"
jq -e '[.server.mods[].file] == ["lib.jar", "shared.jar", "spark.jar"]' "${manifest}" >/dev/null
jq -e '.client.kind == "mod-set" and [.client.mods[].file] == ["lib.jar", "minimap.jar", "shared.jar"]' "${manifest}" >/dev/null
jq -e '(.server.mods[] | select(.file == "shared.jar") | .sha256) == (.client.mods[] | select(.file == "shared.jar") | .sha256)' "${manifest}" >/dev/null

# --- publication: players' own mods beside the server's, and a pack of the players set ---
output="$(RELEASE_SOURCE_DIR="${fixture}/sides" "${scripts}/upload-release.sh" "${manifest}")"
grep -qx 'result=uploaded' <<<"${output}"
grep -qx 'client_mods=3' <<<"${output}"
release="${FAKE_S3_ROOT}/${RELEASE_BUCKET}/releases/minecraft/sides/1.0"
[[ "$(files "${release}/mods")" == "lib.jar shared.jar spark.jar" ]]
# Only what the server does not already store.
[[ "$(files "${release}/client-mods")" == "minimap.jar" ]]
pack="$(unzip -Z1 "${release}/client.zip" | sort | paste -sd ' ' -)"
[[ "${pack}" == "INSTALL.txt lib.jar minimap.jar shared.jar" ]]
[[ "$(unzip -p "${release}/client.zip" minimap.jar)" == "jar minimap" ]]
output="$(RELEASE_SOURCE_DIR="${fixture}/sides" "${scripts}/upload-release.sh" "${manifest}")"
grep -qx 'result=already_present' <<<"${output}"

# --- a pack built from the stored files alone: shared mods from the server's ---
rm -- "${release}/client.zip"
rm -rf -- "${fixture}/sides/client-mods"
mkdir -p -- "${fixture}/sides/client-mods"
cp -- "${release}/client-mods/minimap.jar" "${fixture}/sides/client-mods/"
output="$(RELEASE_SOURCE_DIR="${fixture}/sides" "${scripts}/upload-release.sh" "${manifest}")"
grep -qx 'pack=uploaded' <<<"${output}"
[[ "$(unzip -Z1 "${release}/client.zip" | sort | paste -sd ' ' -)" == "INSTALL.txt lib.jar minimap.jar shared.jar" ]]

# --- a preset without side lists is published exactly as before ---
"${scripts}/resolve-profile-mods.sh" "${config}/profiles/plain" "${fixture}/plain/mods" >/dev/null
[[ ! -e "${fixture}/plain/client-mods" ]]
"${scripts}/build-profile-release.sh" "${config}/profiles/plain" 1.0 \
  "${fixture}/plain/mods" "${fixture}/plain/manifest.json" >/dev/null
jq -e 'has("client") | not' "${fixture}/plain/manifest.json" >/dev/null

# --- refusals ---
refuses "resolves shared.jar to other bytes" "a players mod with a server mod's name and other bytes" \
  "${scripts}/resolve-profile-mods.sh" "${config}/profiles/conflict" "${fixture}/conflict/mods"
[[ ! -e "${fixture}/conflict/mods" && ! -e "${fixture}/conflict/client-mods" ]]
refuses "adds no mod" "a side list that adds nothing" \
  "${scripts}/resolve-profile-mods.sh" "${config}/profiles/nothing-new" "${fixture}/nothing-new/mods"
refuses "invalid profile metadata" "side lists beside a CurseForge modpack" \
  "${scripts}/resolve-profile-mods.sh" "${config}/profiles/modpack" "${fixture}/modpack/mods"
refuses "invalid profile metadata" "side lists without a source list" \
  "${scripts}/resolve-profile-mods.sh" "${config}/profiles/without-source" "${fixture}/without-source/mods"
mkdir -p -- "${fixture}/mismatch"
cp -R -- "${fixture}/sides/mods" "${fixture}/mismatch/mods"
refuses "produced no client-mods" "side lists whose players set the resolver did not write" \
  "${scripts}/build-profile-release.sh" "${config}/profiles/sides" 1.1 \
  "${fixture}/mismatch/mods" "${fixture}/mismatch/manifest.json"
jq '.client.mods[0].sha256 = ("0" * 64)' "${manifest}" >"${fixture}/tampered.json"
refuses "invalid release manifest" "a players mod that shares a server mod's name but not its digest" \
  env RELEASE_SOURCE_DIR="${fixture}/sides" "${scripts}/upload-release.sh" "${fixture}/tampered.json"

printf 'client mod sets test passed\n'
