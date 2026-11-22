#!/usr/bin/env bash

# Materialise the addons a modpack profile pins on top of its pack (ADR-0077).
# Every entry names one exact file: a CurseForge project and file id, checked
# against the API's SHA-1 and size, or a Modrinth version, downloaded from the
# Modrinth CDN only and checked against its pinned SHA-512 and size. The output
# is inert data: no downloaded code is run, and the pack is not read here.

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_common.sh
source "${SCRIPT_DIR}/_common.sh"

addons_file="${1:-}"
profile_directory="${2:-}"
output_dir="${3:-}"
[[ -n "${addons_file}" && -n "${profile_directory}" && -n "${output_dir}" ]] ||
  die "usage: resolve-addons.sh <addons.json> <profile-directory> <new-output-directory>"

for command in curl find jq realpath sha1sum sha256sum sha512sum stat; do
  require_command "${command}"
done
minecraft_version="${ADDONS_MINECRAFT_VERSION:-}"
loader_type="${ADDONS_LOADER_TYPE:-}"
[[ -n "${minecraft_version}" && -n "${loader_type}" ]] ||
  die "ADDONS_MINECRAFT_VERSION and ADDONS_LOADER_TYPE are required"
case "${loader_type}" in
  forge | neoforge | fabric | quilt) ;;
  *) die "addons need a mod loader, not ${loader_type}" ;;
esac

addons_file="$(realpath -e -- "${addons_file}")"
profile_directory="$(realpath -e -- "${profile_directory}")"
output_dir="$(realpath -m -- "${output_dir}")"
[[ -f "${addons_file}" && ! -L "${addons_file}" ]] || die "addons file must be a regular file"
[[ ! -e "${output_dir}" && ! -L "${output_dir}" ]] || die "immutable addons output already exists: ${output_dir}"

# The shape of addons.json. Paths in config are relative to the profile.
jq -e '
  def safe_jar: type == "string" and test("^[A-Za-z0-9][A-Za-z0-9._+-]*\\.jar$");
  def safe_relative: type == "string" and length > 0 and (startswith("/") | not) and (contains("\\") | not) and
    (split("/") | all(. != "" and . != "." and . != ".."));
  def sha512: type == "string" and test("^[0-9a-f]{128}$");
  def positive: type == "number" and floor == . and . > 0;
  .schema_version == 1 and
  (keys - ["schema_version", "mods", "config"] | length == 0) and
  (.mods | type == "array" and length > 0) and
  all(.mods[];
    (keys - ["name", "side", "required_by", "curseforge", "modrinth"] | length == 0) and
    (.name | type == "string" and length > 0) and
    (.side | IN("both", "server", "client")) and
    ((.required_by // []) | type == "array" and all(.[]; type == "string" and length > 0)) and
    ([has("curseforge"), has("modrinth")] | map(select(.)) | length == 1) and
    (if has("curseforge") then
      (.curseforge | keys - ["project_id", "file_id", "mirror"] | length == 0) and
      (.curseforge.project_id | positive) and (.curseforge.file_id | positive) and
      ((.curseforge | has("mirror") | not) or (
        (.curseforge.mirror | keys - ["url", "sha512", "bytes"] | length == 0) and
        (.curseforge.mirror.url | type == "string" and startswith("https://")) and
        (.curseforge.mirror.sha512 | sha512) and (.curseforge.mirror.bytes | positive)))
    else
      (.modrinth | keys - ["project_id", "version_id", "file", "sha512", "bytes"] | length == 0) and
      (.modrinth.project_id | type == "string" and test("^[A-Za-z0-9]{8}$")) and
      (.modrinth.version_id | type == "string" and test("^[A-Za-z0-9]{8}$")) and
      (.modrinth.file | safe_jar) and (.modrinth.sha512 | sha512) and (.modrinth.bytes | positive)
    end)) and
  ([.mods[].name] | length == (unique | length)) and
  ([.mods[] | .curseforge.project_id // empty] | length == (unique | length)) and
  ([.mods[] | .modrinth.project_id // empty] | length == (unique | length)) and
  ([.mods[] | .modrinth.file // empty] | length == (unique | length)) and
  ((has("config") | not) or (
    (.config | keys - ["tree", "replaces"] | length == 0) and
    (.config.tree | safe_relative) and
    (.config.replaces | type == "array" and all(.[]; safe_relative) and length == (unique | length))))
' "${addons_file}" >/dev/null || die "invalid addons file: ${addons_file}"

api_base="${CF_API_BASE:-https://api.curseforge.com}"
readonly MODRINTH_CDN="https://cdn.modrinth.com/data"

workspace="$(mktemp -d "$(dirname -- "${output_dir}")/.addons.XXXXXXXX")"
cleanup() {
  rm -rf -- "${workspace}"
}
trap cleanup EXIT
result="${workspace}/result"
mkdir -p -- "${result}/both" "${result}/server" "${result}/client"
entries="${workspace}/entries.jsonl"
: >"${entries}"

fetch() {
  local url="$1" destination="$2"
  curl -fsSL --proto '=https' --retry 3 --connect-timeout 20 --max-time 600 -o "${destination}" "${url}"
}

cf_get() {
  [[ -n "${CF_API_KEY:-}" ]] || die "CF_API_KEY is required for a CurseForge addon"
  curl -fsSL --retry 3 --connect-timeout 20 --max-time 120 -H "x-api-key: ${CF_API_KEY}" "$1"
}

# The loader names CurseForge lists among a file's game versions.
case "${loader_type}" in
  forge) cf_loader="Forge" ;;
  neoforge) cf_loader="NeoForge" ;;
  fabric) cf_loader="Fabric" ;;
  quilt) cf_loader="Quilt" ;;
esac

resolve_curseforge() {
  local index="$1" label="$2" destination_dir="$3"
  local project_id file_id project metadata filename expected_sha expected_bytes url download actual_sha mirror distributable
  project_id="$(jq -r --argjson i "${index}" '.mods[$i].curseforge.project_id' "${addons_file}")"
  file_id="$(jq -r --argjson i "${index}" '.mods[$i].curseforge.file_id' "${addons_file}")"
  project="${workspace}/project-${project_id}.json"
  metadata="${workspace}/file-${project_id}-${file_id}.json"
  cf_get "${api_base}/v1/mods/${project_id}" >"${project}" || die "CurseForge project lookup failed for ${label}"
  jq -e --argjson id "${project_id}" '.data.id == $id and .data.gameId == 432 and .data.classId == 6' \
    "${project}" >/dev/null || die "${label}: CurseForge project ${project_id} is not a Minecraft mod"
  cf_get "${api_base}/v1/mods/${project_id}/files/${file_id}" >"${metadata}" ||
    die "CurseForge file lookup failed for ${label}"
  jq -e --argjson project "${project_id}" --argjson file "${file_id}" '
    .data.modId == $project and .data.id == $file and
    (.data.fileName | type == "string" and test("^[A-Za-z0-9][A-Za-z0-9._+-]*\\.jar$")) and
    (.data.fileLength | type == "number" and floor == . and . > 0) and
    ((.data.downloadUrl // null) == null or (.data.downloadUrl | type == "string" and startswith("https://"))) and
    ([.data.hashes[]? | select(.algo == 1) | .value] | length == 1 and (.[0] | test("^[0-9a-f]{40}$")))
  ' "${metadata}" >/dev/null || die "${label}: CurseForge returned unsafe or incomplete file metadata"
  # C1 at the source: the file must be published for this game version and loader.
  jq -e --arg minecraft "${minecraft_version}" --arg loader "${cf_loader}" '
    (.data.gameVersions // []) as $versions |
    ($versions | index($minecraft)) != null and
    ($versions | map(ascii_downcase) | index($loader | ascii_downcase)) != null
  ' "${metadata}" >/dev/null ||
    die "C1 ${label}: CurseForge file ${file_id} is not published for Minecraft ${minecraft_version} on ${cf_loader}"
  filename="$(jq -r '.data.fileName' "${metadata}")"
  expected_sha="$(jq -r '[.data.hashes[] | select(.algo == 1)][0].value' "${metadata}")"
  expected_bytes="$(jq -r '.data.fileLength' "${metadata}")"
  url="$(jq -r '.data.downloadUrl // empty' "${metadata}")"
  distributable="$(jq -r 'if .data.allowModDistribution == false then "false" else "true" end' "${project}")"
  [[ -n "${url}" ]] || distributable=false
  mirror="$(jq -c --argjson i "${index}" '.mods[$i].curseforge.mirror // empty' "${addons_file}")"
  download="${workspace}/download-${index}"
  if [[ "${distributable}" == true ]]; then
    fetch "${url}" "${download}" || die "CurseForge download failed for ${label}"
  else
    # The author switched third-party distribution off. Respect it unless the
    # same bytes come from a reviewed mirror (the ADR-0068 rule).
    [[ -n "${mirror}" ]] ||
      die "${label}: CurseForge project ${project_id} disables third-party distribution; pin the same file from Modrinth or a mirror"
    fetch "$(jq -r '.url' <<<"${mirror}")" "${download}" || die "mirror download failed for ${label}"
    actual_sha="$(sha512sum -- "${download}")"
    [[ "${actual_sha%% *}" == "$(jq -r '.sha512' <<<"${mirror}")" &&
      "$(stat --format '%s' -- "${download}")" == "$(jq -r '.bytes' <<<"${mirror}")" ]] ||
      die "${label}: mirror does not match its pinned SHA-512 and size"
  fi
  # CurseForge's own integrity field, checked with the exact size; not a signature.
  actual_sha="$(sha1sum -- "${download}")" # NOSONAR
  [[ "${actual_sha%% *}" == "${expected_sha}" && "$(stat --format '%s' -- "${download}")" == "${expected_bytes}" ]] ||
    die "${label}: download does not match CurseForge SHA-1 and size"
  [[ ! -e "${destination_dir}/${filename}" ]] || die "${label}: two addons resolve to ${filename}"
  mv -- "${download}" "${destination_dir}/${filename}"
  jq -cn --argjson project "${project_id}" --argjson file "${file_id}" --arg filename "${filename}" \
    '{curseforge: {project_id: $project, file_id: $file}, file: $filename}'
}

resolve_modrinth() {
  local index="$1" label="$2" destination_dir="$3"
  local pin project_id version_id filename url download actual_sha
  pin="$(jq -c --argjson i "${index}" '.mods[$i].modrinth' "${addons_file}")"
  project_id="$(jq -r '.project_id' <<<"${pin}")"
  version_id="$(jq -r '.version_id' <<<"${pin}")"
  filename="$(jq -r '.file' <<<"${pin}")"
  # The URL is built here, never read from the pin: the CDN is the only source.
  url="${MODRINTH_CDN}/${project_id}/versions/${version_id}/${filename//+/%2B}"
  download="${workspace}/download-${index}"
  fetch "${url}" "${download}" || die "Modrinth download failed for ${label}"
  actual_sha="$(sha512sum -- "${download}")"
  [[ "${actual_sha%% *}" == "$(jq -r '.sha512' <<<"${pin}")" &&
    "$(stat --format '%s' -- "${download}")" == "$(jq -r '.bytes' <<<"${pin}")" ]] ||
    die "${label}: download does not match the pinned SHA-512 and size"
  [[ ! -e "${destination_dir}/${filename}" ]] || die "${label}: two addons resolve to ${filename}"
  mv -- "${download}" "${destination_dir}/${filename}"
  jq -cn --argjson pin "${pin}" '{modrinth: ($pin | {project_id, version_id}), file: $pin.file}'
}

count="$(jq '.mods | length' "${addons_file}")"
for (( index = 0; index < count; index++ )); do
  name="$(jq -r --argjson i "${index}" '.mods[$i].name' "${addons_file}")"
  side="$(jq -r --argjson i "${index}" '.mods[$i].side' "${addons_file}")"
  label="addon \"${name}\""
  if jq -e --argjson i "${index}" '.mods[$i] | has("curseforge")' "${addons_file}" >/dev/null; then
    pinned="$(resolve_curseforge "${index}" "${label}" "${result}/${side}")"
  else
    pinned="$(resolve_modrinth "${index}" "${label}" "${result}/${side}")"
  fi
  filename="$(jq -r '.file' <<<"${pinned}")"
  # One file name across every side, as one client pack and one server set hold them.
  [[ "$(find "${result}" -mindepth 2 -maxdepth 2 -type f -name "${filename}" | wc -l)" == 1 ]] ||
    die "${label}: another addon already resolves to ${filename}"
  digest="$(sha256sum -- "${result}/${side}/${filename}")"
  jq -cn --argjson pinned "${pinned}" --arg name "${name}" --arg side "${side}" --arg sha256 "${digest%% *}" \
    --argjson bytes "$(stat --format '%s' -- "${result}/${side}/${filename}")" \
    '{name: $name, side: $side, source: ($pinned | del(.file)), file: $pinned.file, sha256: $sha256, bytes: $bytes}' \
    >>"${entries}"
done

# The optional config tree: regular files under the allowed roots only, plus
# client/ with the same roots for files players get and the server does not.
config="$(jq -c '.config // null' "${addons_file}")"
if [[ "${config}" != null ]]; then
  tree_relative="$(jq -r '.tree' <<<"${config}")"
  [[ ! -L "${profile_directory}/${tree_relative}" ]] || die "addons config tree must not be a symlink"
  tree="$(realpath -e -- "${profile_directory}/${tree_relative}")" || die "addons config tree is missing: ${tree_relative}"
  [[ "${tree}" == "${profile_directory}/"* && -d "${tree}" ]] || die "addons config tree must be a folder inside the profile"
  if find "${tree}" -mindepth 1 \( -type l -o ! -type f -a ! -type d \) -print -quit | grep -q .; then
    die "addons config tree contains a symbolic link or special file"
  fi
  while IFS= read -r -d '' file; do
    relative="${file#"${tree}/"}"
    [[ "${relative}" != *$'\n'* && "${relative}" != *$'\t'* && "${relative}" != *\\* ]] ||
      die "unsafe addons config path: ${relative}"
    rest="${relative#client/}"
    root=""
    [[ "${rest}" != */* ]] || root="${rest%%/*}"
    case "${root}" in
      config | defaultconfigs | kubejs | scripts | global_packs | openloader) ;;
      *) die "addons config path is outside the allowed roots: ${relative}" ;;
    esac
  done < <(find "${tree}" -type f -print0)
  mkdir -p -- "${result}/config"
  cp -a -- "${tree}/." "${result}/config/"
fi

jq -s --argjson config "${config}" '{schema_version: 1, mods: ., config: (if $config == null then null else {tree: $config.tree, replaces: ($config.replaces | sort)} end)}' \
  "${entries}" >"${result}/addons-lock.json"
mv -T -- "${result}" "${output_dir}"

printf 'result=resolved\n'
printf 'addons=%s\n' "${count}"
printf 'output=%s\n' "${output_dir}"
