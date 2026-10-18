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

for command in curl find jq realpath sha1sum stat unzip; do
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
  (.server_pack_file_id | type == "number" and floor == . and . > 0)
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
  curl -fsSL -H "x-api-key: ${CF_API_KEY}" "${url}"
}

file_metadata() {
  local requested_id="$1" destination="$2"
  cf_get "${api_base}/v1/mods/${project_id}/files/${requested_id}" >"${destination}" ||
    die "CurseForge file lookup failed for ${project_id}:${requested_id}"
  jq -e \
    --argjson project "${project_id}" \
    --argjson file "${requested_id}" '
      .data.modId == $project and
      .data.id == $file and
      (.data.fileName | type == "string" and test("^[^/\\\\]+\\.zip$"; "i")) and
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
  url="$(file_download_url "${metadata}" "${requested_id}")"
  expected_sha="$(jq -r '[.data.hashes[] | select(.algo == 1)][0].value' "${metadata}")"
  expected_bytes="$(jq -r '.data.fileLength' "${metadata}")"
  curl -fsSL -H "x-api-key: ${CF_API_KEY}" -o "${destination}" "${url}" ||
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

# Reject traversal and Windows-path tricks before extraction. Symlinks and
# other special entries are rejected again against the extracted tree.
while IFS= read -r member; do
  [[ -n "${member}" ]] || continue
  [[ "${member}" != /* && "${member}" != *\\* ]] || die "unsafe path in CurseForge server pack: ${member}"
  IFS='/' read -r -a components <<<"${member}"
  for component in "${components[@]}"; do
    [[ -z "${component}" || ("${component}" != "." && "${component}" != "..") ]] ||
      die "unsafe path in CurseForge server pack: ${member}"
  done
done < <(unzip -Z1 "${server_archive}")

extracted="${workspace}/extracted"
mkdir -p -- "${extracted}"
unzip -q "${server_archive}" -d "${extracted}"
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
cp -- "${client_archive}" "${workspace}/result/client.zip"
mv -T -- "${workspace}/result" "${output_dir}"

printf 'result=resolved\n'
printf 'project_id=%s\n' "${project_id}"
printf 'file_id=%s\n' "${file_id}"
printf 'server_pack_file_id=%s\n' "${server_pack_file_id}"
printf 'mods=%s\n' "${mod_count}"
printf 'overrides=%s\n' "${override_count}"
printf 'output=%s\n' "${output_dir}"
