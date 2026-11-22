#!/usr/bin/env bash

# World-owned data (ADR-0010, ADR-0034, ADR-0077): plugin folders, server
# config files, mods/<folder>/ and world_data paths are in every archive and
# come back on restore; caches stay out; a release change and an overrides
# swap keep them; an archive made before all this still verifies and restores.

set -Eeuo pipefail

REPOSITORY_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPTS="${REPOSITORY_ROOT}/server/scripts"
fixture="$(mktemp -d /tmp/spawnpoint-world-owned-data-test.XXXXXXXX)"
cleanup() {
  rm -rf -- "${fixture}"
}
trap cleanup EXIT

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
}

checksum_beside() {
  local archive="$1"
  (
    cd -- "$(dirname -- "${archive}")"
    sha256sum -- "$(basename -- "${archive}")" >"$(basename -- "${archive}").sha256"
  )
}

# Every file and link under a directory with its digest or target: equal
# snapshots mean nothing was changed, moved or deleted.
snapshot() {
  (
    cd -- "$1"
    find . \( -type f -o -type l \) -print0 | LC_ALL=C sort -z | while IFS= read -r -d '' path; do
      if [[ -L "${path}" ]]; then
        printf '%s -> %s\n' "${path}" "$(readlink -- "${path}")"
      else
        printf '%s %s\n' "${path}" "$(sha256sum -- "${path}" | awk '{print $1}')"
      fi
    done
  )
}

# The same, for what lies inside the subfolders only.
folders_of() {
  snapshot "$1" | grep '^\./[^/ ]*/'
}

write() {
  mkdir -p -- "$(dirname -- "$1")"
  printf '%s\n' "${2:-$1}" >"$1"
}

# A mv that fails when its source matches one of FAKE_MV_FAIL's patterns.
mkdir -p -- "${fixture}/bin"
real_mv="$(command -v mv)"
cat >"${fixture}/bin/mv" <<EOF
#!/usr/bin/env bash
source_path="\${*: -2:1}"
for pattern in \${FAKE_MV_FAIL:-}; do
  # shellcheck disable=SC2053
  if [[ "\${source_path}" == \${pattern} ]]; then
    printf 'fake mv: refusing %s\n' "\${source_path}" >&2
    exit 1
  fi
done
exec "${real_mv}" "\$@"
EOF
chmod 0755 "${fixture}/bin/mv"

# --- a Paper-shaped and Fabric-shaped world on the generation layout ---
world="${fixture}/world"
data="${world}/data"
for path in world/level.dat world/libraries/kept.dat world_nether/DIM-1/r.0.0.mca \
  plugins/LuckPerms/config.yml plugins/LuckPerms/libs-data/kept.dat plugins/Geyser/ext/extension.jar \
  bukkit.yml spigot.yml config/paper-global.yml config/paper-world-defaults.yml \
  plugins/LuckPerms-Bukkit.jar plugins/LuckPerms/libs/h2.jar plugins/.paper-remapped/remapped.jar \
  config/release-owned.toml libraries/library.jar cache/mojang.jar versions/1.20.1/paper.jar server.properties; do
  write "${data}/${path}"
done
mkdir -p -- "${data}/mods"
write "${world}/mods/fabric-api.jar"
write "${world}/mods/luckperms/luckperms-h2-v2.mv.db"
write "${world}/mods/luckperms/libs/h2.jar"
ln -s luckperms-h2-v2.mv.db "${world}/mods/luckperms/current"
mkdir -p -- "${world}/mods/empty-data"

archive_output="$(
  SERVER_DATA_DIR="${data}" SERVER_BACKUP_DIR="${fixture}/backups" WORLD_NAME=world \
    "${SCRIPTS}/archive-world.sh"
)"
archive="$(awk -F= '$1 == "archive" { print $2 }' <<<"${archive_output}")"
grep -qx 'mod_data_directories=2' <<<"${archive_output}"

listing="$(tar --list --zstd --file "${archive}" | grep -v '/$' | LC_ALL=C sort)"
expected="$(LC_ALL=C sort <<'EOF'
world/level.dat
world/libraries/kept.dat
world_nether/DIM-1/r.0.0.mca
plugins/LuckPerms/config.yml
plugins/LuckPerms/libs-data/kept.dat
plugins/Geyser/ext/extension.jar
bukkit.yml
spigot.yml
config/paper-global.yml
config/paper-world-defaults.yml
mods-data/luckperms/luckperms-h2-v2.mv.db
mods-data/luckperms/libs/h2.jar
mods-data/luckperms/current
EOF
)"
[[ "${listing}" == "${expected}" ]] || {
  printf 'archive entries differ from the expected set\n' >&2
  diff <(printf '%s\n' "${expected}") <(printf '%s\n' "${listing}") >&2 || true
  exit 1
}
tar --list --zstd --file "${archive}" | grep -qx 'mods-data/empty-data/'
"${SCRIPTS}/verify-archive.sh" "${archive}" >/dev/null

# --- restore of a new archive: save into data, mod data into mods ---
refuses "name the mods directory" "mod data with nowhere to go" \
  "${SCRIPTS}/restore-world.sh" "${archive}" "${fixture}/no-mods/data"
[[ ! -e "${fixture}/no-mods/data" ]]

mkdir -p -- "${fixture}/clash/mods/luckperms"
write "${fixture}/clash/mods/luckperms/other.db"
refuses "already holds luckperms; refusing to merge" "a mods directory with a folder of the same name" \
  "${SCRIPTS}/restore-world.sh" "${archive}" "${fixture}/clash/data" "${fixture}/clash/mods"
[[ ! -e "${fixture}/clash/data" ]]
[[ "$(find "${fixture}/clash/mods" -type f -printf '%P\n')" == "luckperms/other.db" ]]

mkdir -p -- "${fixture}/live-server/mods"
refuses "live mods directory" "the live mods directory" \
  env SERVER_PROJECT_DIRECTORY="${fixture}/live-server" \
  "${SCRIPTS}/restore-world.sh" "${archive}" "${fixture}/live-target/data" "${fixture}/live-server/mods"

refuses "live mods directory of the world" "the world's own live mods directory" \
  env SPAWNPOINT_WORLD_MODS_DIRECTORY="${fixture}/world-live/mods" \
  "${SCRIPTS}/restore-world.sh" "${archive}" "${fixture}/world-live-target/data" "${fixture}/world-live/mods"
[[ ! -e "${fixture}/world-live-target/data" ]]

mkdir -p -- "${fixture}/restored/mods"
restore_output="$("${SCRIPTS}/restore-world.sh" "${archive}" "${fixture}/restored/data" "${fixture}/restored/mods")"
grep -qx 'mod_data_directories=2' <<<"${restore_output}"
[[ ! -e "${fixture}/restored/data/mods-data" ]]
diff -r -- "${world}/mods/luckperms" "${fixture}/restored/mods/luckperms"
[[ -d "${fixture}/restored/mods/empty-data" && "$(readlink -- "${fixture}/restored/mods/luckperms/current")" == "luckperms-h2-v2.mv.db" ]]
for path in world/level.dat world/libraries/kept.dat plugins/LuckPerms/libs-data/kept.dat \
  plugins/Geyser/ext/extension.jar bukkit.yml config/paper-world-defaults.yml; do
  cmp -- "${data}/${path}" "${fixture}/restored/data/${path}"
done
for path in plugins/LuckPerms-Bukkit.jar plugins/LuckPerms/libs plugins/.paper-remapped libraries cache versions \
  config/release-owned.toml server.properties; do
  [[ ! -e "${fixture}/restored/data/${path}" ]] || { printf 'restored an excluded path: %s\n' "${path}" >&2; exit 1; }
done

# --- verify: mods-data/ holds folders only ---
mkdir -p -- "${fixture}/stray/world" "${fixture}/stray/mods-data"
write "${fixture}/stray/world/level.dat"
write "${fixture}/stray/mods-data/unverified.jar"
tar --create --zstd --file "${fixture}/backups/stray.tar.zst" --directory "${fixture}/stray" world mods-data
checksum_beside "${fixture}/backups/stray.tar.zst"
refuses "mods-data/ may hold only folders: mods-data/unverified.jar" "a file directly under mods-data/" \
  "${SCRIPTS}/verify-archive.sh" "${fixture}/backups/stray.tar.zst"

# --- an archive made before mods-data/ verifies and restores as before ---
mkdir -p -- "${fixture}/old/world/region" "${fixture}/old/world_nether"
write "${fixture}/old/world/level.dat"
write "${fixture}/old/world/region/r.0.0.mca"
write "${fixture}/old/world_nether/marker"
old_archive="${fixture}/backups/world-20260801T000000Z.tar.zst"
tar --create --zstd --file "${old_archive}" --directory "${fixture}/old" world world_nether
checksum_beside "${old_archive}"
"${SCRIPTS}/verify-archive.sh" "${old_archive}" >/dev/null
"${SCRIPTS}/restore-world.sh" "${old_archive}" "${fixture}/old-restored" | grep -qx 'mod_data_directories=0'
diff -r -- "${fixture}/old" "${fixture}/old-restored"
mkdir -p -- "${fixture}/old-staged/mods"
"${SCRIPTS}/restore-world.sh" "${old_archive}" "${fixture}/old-staged/data" "${fixture}/old-staged/mods" >/dev/null
diff -r -- "${fixture}/old" "${fixture}/old-staged/data"
[[ -z "$(find "${fixture}/old-staged/mods" -mindepth 1 -print -quit)" ]]

# --- the adapter: world_data paths the installed release keeps are saved too ---
# shellcheck source=../games/minecraft/game.sh
source "${REPOSITORY_ROOT}/server/games/minecraft/game.sh"
paths_of() {
  game_save_paths "$1" world | tr '\0' '\n'
}
adapter="${fixture}/adapter"
write "${adapter}/world/level.dat"
write "${adapter}/config/mod/data/db.bin"
jq -n '{schema_version: 1, release: "1.0", roots: ["config"]}' >"${adapter}/.spawnpoint-overrides.json"
[[ "$(paths_of "${adapter}")" == "world" ]]
jq -n '{schema_version: 1, release: "1.0", roots: ["config"], world_data: ["config/mod/data", "config/gone", "../escape"]}' \
  >"${adapter}/.spawnpoint-overrides.json"
[[ "$(paths_of "${adapter}" | paste -sd ' ' -)" == "world .spawnpoint-overrides.json config/mod/data" ]]
# The server's player lists travel with the save, so a fresh host keeps its operators and bans.
for list in ops.json banned-players.json banned-ips.json whitelist.json usercache.json; do
  printf '[]\n' >"${adapter}/${list}"
done
ln -s ops.json "${adapter}/linked.json"
[[ "$(paths_of "${adapter}" | paste -sd ' ' -)" == "world ops.json banned-players.json banned-ips.json whitelist.json usercache.json .spawnpoint-overrides.json config/mod/data" ]]
rm -f -- "${adapter}/ops.json" && ln -s /etc/passwd "${adapter}/ops.json"
if paths_of "${adapter}" | grep -qx 'ops.json'; then
  printf 'a player list that is a link must not be saved\n' >&2
  exit 1
fi
mapfile -d '' excludes < <(game_save_excludes)
[[ "${excludes[*]}" == "plugins/*.jar plugins/.paper-remapped plugins/*/libs libraries cache versions" ]]

# --- the release swap keeps every folder of the old mods directory ---
release="${fixture}/release"
write "${release}/mods/alpha.jar" 'alpha'
RELEASE_GAME=minecraft RELEASE_LOADER_TYPE=fabric \
  "${SCRIPTS}/build-release-manifest.sh" 1.0 1.20.1 0.19.3 "${release}/mods" "${release}/manifest.json" >/dev/null
server="${fixture}/server"
write "${server}/mods/stale.jar" 'stale'
write "${server}/mods/luckperms/luckperms-h2-v2.mv.db" 'permissions'
write "${server}/mods/luckperms/libs/h2.jar" 'h2'
write "${server}/mods/other-data/state.json" 'state'
folders_before="$(folders_of "${server}/mods")"
leftovers() {
  find "${server}" -mindepth 1 -maxdepth 1 -name '.mods.*' -print
}

# A failed move out leaves every folder where it was.
refuses "could not move other-data out" "a folder that cannot move" \
  env PATH="${fixture}/bin:${PATH}" FAKE_MV_FAIL="*/mods/other-data" \
  "${SCRIPTS}/reconcile-release.sh" "${release}/manifest.json" "${server}/mods"
[[ "$(folders_of "${server}/mods")" == "${folders_before}" && -f "${server}/mods/stale.jar" ]]
[[ -z "$(leftovers)" ]]

# A folder that cannot go back stays in the kept stage; nothing is deleted.
refuses "it is kept in" "a folder that cannot go back" \
  env PATH="${fixture}/bin:${PATH}" FAKE_MV_FAIL="*/mods/other-data */.mods.1.0.stage.*/luckperms" \
  "${SCRIPTS}/reconcile-release.sh" "${release}/manifest.json" "${server}/mods"
kept_stage="$(find "${server}" -mindepth 1 -maxdepth 1 -name '.mods.1.0.stage.*' -print)"
[[ -n "${kept_stage}" && -f "${kept_stage}/luckperms/luckperms-h2-v2.mv.db" && -f "${server}/mods/other-data/state.json" ]]
[[ -f "${server}/mods/stale.jar" && ! -e "${server}/mods/alpha.jar" ]]
mv -T -- "${kept_stage}/luckperms" "${server}/mods/luckperms"
rm -rf -- "${kept_stage}"
[[ "$(folders_of "${server}/mods")" == "${folders_before}" ]]

# A failed swap puts the old directory and every folder back.
refuses "" "a swap that fails" \
  env PATH="${fixture}/bin:${PATH}" FAKE_MV_FAIL="*/.mods.1.0.stage.??????" \
  "${SCRIPTS}/reconcile-release.sh" "${release}/manifest.json" "${server}/mods"
[[ "$(folders_of "${server}/mods")" == "${folders_before}" && -f "${server}/mods/stale.jar" ]]
[[ -z "$(leftovers)" ]]

# A release that ships a file under the name of a folder stops first.
mkdir -p -- "${server}/mods/alpha.jar"
refuses "the release ships alpha.jar, which is a folder of world data" "a release file named like a folder" \
  "${SCRIPTS}/reconcile-release.sh" "${release}/manifest.json" "${server}/mods"
[[ -d "${server}/mods/alpha.jar" && -f "${server}/mods/stale.jar" ]]
rmdir -- "${server}/mods/alpha.jar"

reconcile_output="$("${SCRIPTS}/reconcile-release.sh" "${release}/manifest.json" "${server}/mods")"
grep -qx 'kept_folders=2' <<<"${reconcile_output}"
[[ ! -e "${server}/mods/stale.jar" && "$(cat "${server}/mods/alpha.jar")" == "alpha" ]]
[[ "$(folders_of "${server}/mods")" == "${folders_before}" ]]
[[ -z "$(leftovers)" ]]
"${SCRIPTS}/verify-installed-release.sh" "${release}/manifest.json" "${server}/mods" >/dev/null

# --- the overrides swap keeps world_data paths ---
overrides="${fixture}/overrides"
override_manifest() {
  local version="$1" world_data="$2" path
  shift 2
  local entries='[]'
  for path in "$@"; do
    write "${overrides}/${version}/overrides/${path}" "${version} ${path}"
    entries="$(jq -c --arg path "${path}" --arg sha256 "$(sha256sum "${overrides}/${version}/overrides/${path}" | awk '{print $1}')" \
      --argjson bytes "$(stat --format '%s' "${overrides}/${version}/overrides/${path}")" \
      '. + [{path: $path, sha256: $sha256, bytes: $bytes}]' <<<"${entries}")"
  done
  mkdir -p -- "${overrides}/${version}/overrides"
  jq -n --arg release "${version}" --argjson overrides "${entries}" --argjson world_data "${world_data}" \
    '{release: $release, server: ({overrides: $overrides} + if $world_data == null then {} else {world_data: $world_data} end)}' \
    >"${overrides}/${version}/manifest.json"
}
live="${fixture}/live/data"
write "${live}/world/level.dat"
write "${live}/config/pack/old.json"
write "${live}/config/mod/settings.toml"
write "${live}/config/mod/data/db.bin" 'world-owned'
write "${live}/kubejs/operator.js"

override_manifest 1.0 '["config/mod/data"]' config/pack/server.json
output="$("${SCRIPTS}/reconcile-server-overrides.sh" "${overrides}/1.0/manifest.json" "${live}")"
grep -qx 'world_data=1' <<<"${output}"
[[ "$(cat "${live}/config/mod/data/db.bin")" == "world-owned" && -f "${live}/config/pack/server.json" ]]
[[ ! -e "${live}/config/pack/old.json" && ! -e "${live}/config/mod/settings.toml" && -f "${live}/kubejs/operator.js" ]]
jq -e '.roots == ["config"] and .world_data == ["config/mod/data"]' "${live}/.spawnpoint-overrides.json" >/dev/null

# A later release that no longer declares the path still keeps it.
override_manifest 1.1 null config/pack/server.json
"${SCRIPTS}/reconcile-server-overrides.sh" "${overrides}/1.1/manifest.json" "${live}" >/dev/null
[[ "$(cat "${live}/config/mod/data/db.bin")" == "world-owned" ]]
grep -qx '1.1 config/pack/server.json' "${live}/config/pack/server.json"
jq -e '.world_data == ["config/mod/data"]' "${live}/.spawnpoint-overrides.json" >/dev/null

# A release that ships a file where an earlier release kept world data stops
# the start and changes nothing.
before="$(snapshot "${fixture}/live")"
override_manifest 1.2 null config/pack/server.json config/mod/data/new.toml
refuses "ships a file where the world keeps its own data: config/mod/data/new.toml" "a release file over kept world data" \
  "${SCRIPTS}/reconcile-server-overrides.sh" "${overrides}/1.2/manifest.json" "${live}"
[[ "$(snapshot "${fixture}/live")" == "${before}" ]]

# A swap that fails after the data moved puts everything back.
override_manifest 1.3 '["config/mod/data"]' config/pack/server.json
refuses "" "an overrides swap that fails" \
  env PATH="${fixture}/bin:${PATH}" FAKE_MV_FAIL="*/.data.1.3.overrides.????????/config" \
  "${SCRIPTS}/reconcile-server-overrides.sh" "${overrides}/1.3/manifest.json" "${live}"
[[ "$(snapshot "${fixture}/live")" == "${before}" ]]

# A second root that cannot move puts the first root, with its world data, back.
override_manifest 1.4 '["config/mod/data"]' config/pack/server.json kubejs/server.js
refuses "cannot move managed override root" "a second root that cannot move" \
  env PATH="${fixture}/bin:${PATH}" FAKE_MV_FAIL="${live}/kubejs" \
  "${SCRIPTS}/reconcile-server-overrides.sh" "${overrides}/1.4/manifest.json" "${live}"
[[ "$(snapshot "${fixture}/live")" == "${before}" ]]

# When the data cannot go back either, it is kept, never deleted.
refuses "both are kept" "world data that cannot go back" \
  env PATH="${fixture}/bin:${PATH}" \
  FAKE_MV_FAIL="*/.data.1.3.overrides.????????/config */.data.1.3.overrides.*/config/mod/data" \
  "${SCRIPTS}/reconcile-server-overrides.sh" "${overrides}/1.3/manifest.json" "${live}"
[[ "$(cat "${fixture}"/live/.data.1.3.overrides.*/config/mod/data/db.bin)" == "world-owned" ]]

printf 'world-owned-data-test: ok\n'
