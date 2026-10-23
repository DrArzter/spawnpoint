#!/usr/bin/env bash

# Materialise one immutable CurseForge modpack pair: the launcher archive and
# the server pack attached to it. The profile pins both file ids. CurseForge's
# API supplies the byte length, SHA-1 and relationship between them; the
# resulting tree is inert release input and no archive-provided code is run.

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_common.sh
source "${SCRIPT_DIR}/_common.sh"

source_file="${1:-}"
output_dir="${2:-}"
[[ -n "${source_file}" && -n "${output_dir}" ]] ||
  die "usage: resolve-curseforge-modpack.sh <source.json> <new-output-directory>"

for command in curl find jq realpath sha1sum sha256sum sha512sum stat unzip zip; do
  require_command "${command}"
done
[[ -n "${CF_API_KEY:-}" ]] || die "CF_API_KEY is required"

source_file="$(realpath -e -- "${source_file}")"
output_dir="$(realpath -m -- "${output_dir}")"
[[ -f "${source_file}" && ! -L "${source_file}" ]] || die "modpack source must be a regular file"
[[ ! -e "${output_dir}" && ! -L "${output_dir}" ]] || die "immutable modpack output already exists: ${output_dir}"

jq -e '
  .schema_version == 1 and
  (.project_id | type == "number" and floor == . and . > 0) and
  (.file_id | type == "number" and floor == . and . > 0) and
  (.server_pack_file_id | type == "number" and floor == . and . > 0) and
  ((has("client_mirror") | not) or (
    (.client_mirror.url | type == "string" and startswith("https://")) and
    (.client_mirror | .sha512 | type == "string" and test("^[0-9a-f]{128}$")) and
    (.client_mirror.bytes | type == "number" and floor == . and . > 0)))
' "${source_file}" >/dev/null || die "invalid CurseForge modpack source: ${source_file}"

project_id="$(jq -r '.project_id' "${source_file}")"
file_id="$(jq -r '.file_id' "${source_file}")"
server_pack_file_id="$(jq -r '.server_pack_file_id' "${source_file}")"
api_base="${CF_API_BASE:-https://api.curseforge.com}"

workspace="$(mktemp -d "$(dirname -- "${output_dir}")/.curseforge-modpack.XXXXXXXX")"
cleanup() {
  rm -rf -- "${workspace}"
}
trap cleanup EXIT

cf_get() {
  local url="$1"
  curl -fsSL --retry 3 --connect-timeout 20 --max-time 120 -H "x-api-key: ${CF_API_KEY}" "${url}"
}

file_metadata() {
  local requested_id="$1" destination="$2" extension_pattern="${3:-zip}"
  cf_get "${api_base}/v1/mods/${project_id}/files/${requested_id}" >"${destination}" ||
    die "CurseForge file lookup failed for ${project_id}:${requested_id}"
  jq -e \
    --argjson project "${project_id}" \
    --arg extension "${extension_pattern}" \
    --argjson file "${requested_id}" '
      .data.modId == $project and
      .data.id == $file and
      (.data.fileName | type == "string" and test("^[^/\\\\\\t\\r\\n]+\\.(" + $extension + ")$"; "i")) and
      (.data.fileLength | type == "number" and floor == . and . > 0) and
      ((.data.downloadUrl // null) == null or
        (.data.downloadUrl | type == "string" and startswith("https://"))) and
      ([.data.hashes[]? | select(.algo == 1) | .value] | length == 1) and
      ([.data.hashes[]? | select(.algo == 1) | .value][0] | test("^[0-9a-f]{40}$"))
    ' "${destination}" >/dev/null ||
    die "CurseForge returned unsafe or incomplete metadata for ${project_id}:${requested_id}"
}

file_download_url() {
  local metadata="$1" requested_id="$2" response url
  url="$(jq -r '.data.downloadUrl // empty' "${metadata}")"
  if [[ -z "${url}" ]]; then
    response="$(cf_get "${api_base}/v1/mods/${project_id}/files/${requested_id}/download-url")" ||
      die "CurseForge download URL lookup failed for ${project_id}:${requested_id}"
    url="$(jq -er '.data | select(type == "string" and startswith("https://"))' <<<"${response}")" ||
      die "CurseForge returned no safe download URL for ${project_id}:${requested_id}"
  fi
  printf '%s\n' "${url}"
}

download_verified() {
  local metadata="$1" requested_id="$2" destination="$3" label="$4"
  local url expected_sha expected_bytes actual_sha actual_bytes
  url="${5:-}"
  [[ -n "${url}" ]] || url="$(file_download_url "${metadata}" "${requested_id}")"
  expected_sha="$(jq -r '[.data.hashes[] | select(.algo == 1)][0].value' "${metadata}")"
  expected_bytes="$(jq -r '.data.fileLength' "${metadata}")"
  curl -fsSL --retry 3 --connect-timeout 20 --max-time 600 -o "${destination}" "${url}" ||
    die "CurseForge download failed for ${label}"
  # CurseForge exposes SHA-1 as its file-integrity field. The immutable file
  # id and exact byte length are checked alongside it; this is not a password
  # or signature primitive.
  actual_sha="$(sha1sum -- "${destination}")" # NOSONAR
  actual_sha="${actual_sha%% *}"
  actual_bytes="$(stat --format '%s' -- "${destination}")"
  [[ "${actual_sha}" == "${expected_sha}" && "${actual_bytes}" == "${expected_bytes}" ]] ||
    die "downloaded ${label} does not match CurseForge SHA-1 and size"
}

main_metadata="${workspace}/main.json"
server_metadata="${workspace}/server.json"
file_metadata "${file_id}" "${main_metadata}"
file_metadata "${server_pack_file_id}" "${server_metadata}"

[[ "$(jq -r '.data.serverPackFileId // empty' "${main_metadata}")" == "${server_pack_file_id}" ]] ||
  die "CurseForge main file ${file_id} does not name server pack ${server_pack_file_id}"
server_parent="$(jq -r '.data.parentProjectFileId // empty' "${server_metadata}")"
[[ -z "${server_parent}" || "${server_parent}" == "${file_id}" ]] ||
  die "CurseForge server pack ${server_pack_file_id} belongs to another main file"

client_archive="${workspace}/client.zip"
server_archive="${workspace}/server.zip"
download_verified "${main_metadata}" "${file_id}" "${client_archive}" "client pack ${project_id}:${file_id}"
download_verified "${server_metadata}" "${server_pack_file_id}" "${server_archive}" \
  "server pack ${project_id}:${server_pack_file_id}"

# A profile's runtime contract must describe the archive it pins. Reading the
# launcher manifest is data validation only: no pack-provided code is run.
client_manifest_count="$(unzip -Z1 "${client_archive}" | awk '$0 == "manifest.json" { count++ } END { print count + 0 }')"
(( client_manifest_count == 1 )) || die "CurseForge client pack must contain one root manifest.json"
client_manifest="${workspace}/client-manifest.json"
unzip -p "${client_archive}" manifest.json >"${client_manifest}"
expected_minecraft_version="${CURSEFORGE_EXPECTED_MINECRAFT_VERSION:-}"
expected_loader_type="${CURSEFORGE_EXPECTED_LOADER_TYPE:-}"
expected_loader_version="${CURSEFORGE_EXPECTED_LOADER_VERSION:-}"
if [[ -n "${expected_minecraft_version}${expected_loader_type}${expected_loader_version}" ]]; then
  [[ -n "${expected_minecraft_version}" && -n "${expected_loader_type}" && -n "${expected_loader_version}" ]] ||
    die "all expected CurseForge runtime fields must be provided together"
  case "${expected_loader_type}" in
    forge | neoforge | fabric | quilt) ;;
    *) die "unsupported CurseForge modpack loader: ${expected_loader_type}" ;;
  esac
  jq -e \
    --arg minecraft "${expected_minecraft_version}" \
    --arg loader "${expected_loader_type}-${expected_loader_version}" '
      .minecraft.version == $minecraft and
      ([.minecraft.modLoaders[]? | select(.primary == true) | .id] == [$loader])
    ' "${client_manifest}" >/dev/null ||
    die "profile Minecraft/loader pin does not match the CurseForge client manifest"
fi

validate_archive_paths() {
  local archive="$1" member component
  while IFS= read -r member; do
    [[ -n "${member}" ]] || continue
    [[ "${member}" != /* && "${member}" != *\\* && "${member}" != *$'\t'* && "${member}" != *$'\r'* ]] ||
      die "unsafe path in CurseForge archive: ${member}"
    IFS='/' read -r -a components <<<"${member}"
    for component in "${components[@]}"; do
      [[ -z "${component}" || ("${component}" != "." && "${component}" != "..") ]] ||
        die "unsafe path in CurseForge archive: ${member}"
    done
  done < <(unzip -Z1 "${archive}")
  # Reject links before extraction, including links followed by nested files.
  if unzip -Z -l "${archive}" | awk '$1 ~ /^[lbcps]/ { found=1 } END { exit !found }'; then
    die "CurseForge archive contains a link or special file"
  fi
}

validate_archive_paths "${client_archive}"
validate_archive_paths "${server_archive}"
extracted="${workspace}/extracted"
mkdir -p -- "${extracted}"
unzip -q "${server_archive}" -d "${extracted}"
for archive_depth in 1 2 3; do
  [[ -z "$(find "${extracted}" -maxdepth 5 -type d -name mods -print -quit)" ]] || break
  mapfile -d '' nested_archives < <(find "${extracted}" -maxdepth 1 -type f -iname '*.zip' -print0)
  (( ${#nested_archives[@]} == 1 )) || break
  validate_archive_paths "${nested_archives[0]}"
  next_extracted="${workspace}/server-layer-${archive_depth}"
  mkdir -- "${next_extracted}"
  unzip -q "${nested_archives[0]}" -d "${next_extracted}"
  extracted="${next_extracted}"
done
client_tree="${workspace}/client-tree"
mkdir -p -- "${client_tree}"
unzip -q "${client_archive}" -d "${client_tree}"
author_trees=("${extracted}" "${client_tree}")
mirror_index=""
if jq -e 'has("client_mirror")' "${source_file}" >/dev/null; then
  mirror_archive="${workspace}/client-mirror.zip"
  mirror_tree="${workspace}/client-mirror"
  curl -fsSL --retry 3 --connect-timeout 20 --max-time 600 \
    -o "${mirror_archive}" "$(jq -r '.client_mirror.url' "${source_file}")" || die "client mirror download failed"
  mirror_sha="$(sha512sum -- "${mirror_archive}")"
  [[ "${mirror_sha%% *}" == "$(jq -r '.client_mirror | .sha512' "${source_file}")" &&
    "$(stat --format '%s' -- "${mirror_archive}")" == "$(jq -r '.client_mirror.bytes' "${source_file}")" ]] ||
    die "client mirror does not match its pinned SHA-512 and size"
  validate_archive_paths "${mirror_archive}"
  mkdir -- "${mirror_tree}"
  unzip -q "${mirror_archive}" -d "${mirror_tree}"
  author_trees+=("${mirror_tree}")
  [[ ! -f "${mirror_tree}/modrinth.index.json" ]] || mirror_index="${mirror_tree}/modrinth.index.json"
fi
jq -e '
  .manifestType == "minecraftModpack" and .manifestVersion == 1 and
  (.overrides | type == "string" and test("^[A-Za-z0-9_-]+$")) and
  (.files | type == "array") and
  all(.files[];
    (.projectID | type == "number" and floor == . and . > 0) and
    (.fileID | type == "number" and floor == . and . > 0)) and
  ([.files[] | [.projectID, .fileID]] | length == (unique | length))
' "${client_manifest}" >/dev/null || die "invalid CurseForge client manifest"
client_overrides="${client_tree}/$(jq -r '.overrides' "${client_manifest}")"
mkdir -p -- "${client_overrides}"
client_entries="${workspace}/client-entries.jsonl"
touch "${client_entries}"

resolve_client_file() {
  # Dynamic scope keeps every metadata/URL request bound to this dependency's
  # project rather than the modpack project.
  local project_id="$1" dependency_file_id="$2" metadata project category directory filename destination digest downloaded candidate expected_sha expected_bytes candidate_sha mirror_url
  metadata="${workspace}/dependency-${project_id}-${dependency_file_id}.json"
  file_metadata "${dependency_file_id}" "${metadata}" 'jar|zip'
  project="$(cf_get "${api_base}/v1/mods/${project_id}")" || die "CurseForge project lookup failed: ${project_id}"
  jq -e --argjson id "${project_id}" '.data.id == $id and .data.gameId == 432' <<<"${project}" >/dev/null ||
    die "client dependency is not a Minecraft project: ${project_id}"
  category="$(jq -r '.data.classId' <<<"${project}")"
  case "${category}" in
    6) directory=mods ;;
    12) directory=resourcepacks ;;
    6552) directory=shaderpacks ;;
    6945) directory=datapacks ;;
    *) die "unsupported CurseForge client dependency class ${category}: ${project_id}" ;;
  esac
  filename="$(jq -r '.data.fileName' "${metadata}")"
  destination="${client_overrides}/${directory}/${filename}"
  mkdir -p -- "$(dirname -- "${destination}")"
  # mkdir is an atomic claim, including when two projects use the same filename.
  mkdir -- "${workspace}/claims/${directory}-${filename}" 2>/dev/null ||
    die "client dependencies collide: ${directory}/${filename}"
  downloaded="${workspace}/download-${project_id}-${dependency_file_id}"
  # The author may bundle a dependency in either archive while disabling its
  # standalone API download. Reuse only byte-identical, provider-verified files
  # from those already verified author archives.
  expected_sha="$(jq -r '[.data.hashes[] | select(.algo == 1)][0].value' "${metadata}")"
  expected_bytes="$(jq -r '.data.fileLength' "${metadata}")"
  while IFS= read -r -d '' candidate; do
    [[ "$(stat --format '%s' -- "${candidate}")" == "${expected_bytes}" ]] || continue
    # Same provider integrity field as download_verified, not a signature.
    candidate_sha="$(sha1sum -- "${candidate}")" # NOSONAR
    [[ "${candidate_sha%% *}" == "${expected_sha}" ]] || continue
    cp -- "${candidate}" "${downloaded}"
    break
  done < <(find "${author_trees[@]}" -type f -name "${filename}" -print0)
  if [[ ! -f "${downloaded}" ]]; then
    mirror_url=""
    if [[ -n "${mirror_index}" ]]; then
      mirror_url="$(jq -r --arg sha "${expected_sha}" --argjson bytes "${expected_bytes}" '
        [.files[]? | select(.hashes.sha1 == $sha and .fileSize == $bytes) |
          .downloads[]? | select(type == "string" and startswith("https://"))][0] // empty
      ' "${mirror_index}")"
    fi
    download_verified "${metadata}" "${dependency_file_id}" "${downloaded}" \
      "client dependency ${project_id}:${dependency_file_id} (${filename})" "${mirror_url}"
  fi
  # CurseForge applies author overrides after indexed files. Preserve that
  # precedence when the author intentionally replaces a dependency's bytes.
  [[ -e "${destination}" ]] || cp -- "${downloaded}" "${destination}"
  digest="$(sha256sum -- "${destination}")"
  jq -cn --argjson project "${project_id}" --argjson file "${dependency_file_id}" \
    --arg path "${directory}/${filename}" --arg sha256 "${digest%% *}" \
    '{project_id:$project,file_id:$file,path:$path,sha256:$sha256}' >>"${client_entries}"
}
mkdir -- "${workspace}/claims"
client_jobs=()
while IFS=$'\t' read -r dependency_project dependency_file; do
  resolve_client_file "${dependency_project}" "${dependency_file}" &
  client_jobs+=("$!")
  if (( ${#client_jobs[@]} == 8 )); then
    batch_failed=false
    for client_job in "${client_jobs[@]}"; do wait "${client_job}" || batch_failed=true; done
    [[ "${batch_failed}" == false ]] || die "client dependency resolution failed"
    client_jobs=()
  fi
done < <(jq -r '.files[] | [.projectID,.fileID] | @tsv' "${client_manifest}")
batch_failed=false
for client_job in "${client_jobs[@]}"; do wait "${client_job}" || batch_failed=true; done
[[ "${batch_failed}" == false ]] || die "client dependency resolution failed"

# An importable CurseForge pack with every dependency already embedded in its
# overrides. The launcher only installs the pinned Minecraft and loader.
jq '.files = []' "${client_manifest}" >"${client_tree}/manifest.json"
jq -s --argjson project "${project_id}" --argjson file "${file_id}" \
  --slurpfile upstream "${client_manifest}" \
  --slurpfile source "${source_file}" \
  '{schema_version:1,project_id:$project,file_id:$file,source:$source[0],upstream_manifest:$upstream[0],files:sort_by(.path)}' \
  "${client_entries}" >"${client_tree}/spawnpoint-client-lock.json"
find "${client_tree}" -type f -exec touch -t 200001010000 {} +
(cd "${client_tree}" && find . -type f | LC_ALL=C sort | zip -X -q "${workspace}/complete-client.zip" -@)

# Reject traversal and Windows-path tricks before extraction. Symlinks and
# other special entries are rejected again against the extracted tree.
if find "${extracted}" -mindepth 1 \( -type l -o ! -type f -a ! -type d \) -print -quit | grep -q .; then
  die "CurseForge server pack contains a symbolic link or special file"
fi

mapfile -d '' mod_directories < <(
  find "${extracted}" -mindepth 1 -maxdepth 5 -type d -name mods -print0 |
    while IFS= read -r -d '' candidate; do
      find "${candidate}" -maxdepth 1 -type f -iname '*.jar' -print -quit | grep -q . && printf '%s\0' "${candidate}"
    done
)
(( ${#mod_directories[@]} == 1 )) ||
  die "CurseForge server pack must contain exactly one populated mods directory"
pack_root="$(dirname -- "${mod_directories[0]}")"

mkdir -p -- "${workspace}/result/mods" "${workspace}/result/overrides"
while IFS= read -r -d '' mod; do
  filename="$(basename -- "${mod}")"
  [[ "${filename}" =~ ^[^/\\]+\.[Jj][Aa][Rr]$ ]] || die "unsafe mod filename in server pack: ${filename}"
  [[ ! -e "${workspace}/result/mods/${filename}" ]] || die "duplicate mod filename in server pack: ${filename}"
  cp -- "${mod}" "${workspace}/result/mods/${filename}"
done < <(find "${mod_directories[0]}" -maxdepth 1 -type f -iname '*.jar' -print0 | sort -z)

# Only deterministic server configuration enters a release. Launchers,
# installers, worlds, logs, operator lists and server.properties stay out.
override_roots=(config defaultconfigs kubejs scripts global_packs openloader)
for root in "${override_roots[@]}"; do
  candidate="${pack_root}/${root}"
  [[ ! -e "${candidate}" ]] || {
    [[ -d "${candidate}" && ! -L "${candidate}" ]] || die "unsafe override root in server pack: ${root}"
    mkdir -p -- "${workspace}/result/overrides/${root}"
    cp -a -- "${candidate}/." "${workspace}/result/overrides/${root}/"
  }
done

mod_count="$(find "${workspace}/result/mods" -maxdepth 1 -type f -iname '*.jar' | wc -l)"
(( mod_count > 0 )) || die "CurseForge server pack resolved to zero JARs"
override_count="$(find "${workspace}/result/overrides" -type f | wc -l)"
cp -- "${workspace}/complete-client.zip" "${workspace}/result/client.zip"
mv -T -- "${workspace}/result" "${output_dir}"

printf 'result=resolved\n'
printf 'project_id=%s\n' "${project_id}"
printf 'file_id=%s\n' "${file_id}"
printf 'server_pack_file_id=%s\n' "${server_pack_file_id}"
printf 'mods=%s\n' "${mod_count}"
printf 'overrides=%s\n' "${override_count}"
printf 'output=%s\n' "${output_dir}"
