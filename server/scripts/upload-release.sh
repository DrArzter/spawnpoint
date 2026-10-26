#!/usr/bin/env bash

# Publish an immutable release — payload files, manifest, and the client pack —
# to the release bucket. Upload order is deliberate: mods first, manifest last,
# so a partial upload can never present itself as a complete release. The
# manifest's existence is the commit marker.
#
# The pack lives here rather than in one caller because every publisher needs
# it: the workstation cut, the CodeBuild builder and an import all converge on
# this script, and the bot's /pack serves the preset-scoped client.zip.

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_common.sh
source "${SCRIPT_DIR}/_common.sh"
# shellcheck source=_s3.sh
source "${SCRIPT_DIR}/_s3.sh"

manifest="${1:-}"
[[ -n "${manifest}" ]] || die "usage: upload-release.sh <manifest.json> (payload defaults to the manifest's directory; override with RELEASE_SOURCE_DIR)"

require_command aws
require_command jq
require_command base64
require_command openssl
require_command sha256sum

[[ -n "${RELEASE_BUCKET:-}" ]] || die "RELEASE_BUCKET is required"
[[ "${RELEASE_BUCKET}" =~ ^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$ ]] || die "invalid RELEASE_BUCKET: ${RELEASE_BUCKET}"

manifest="$(realpath -e -- "${manifest}")"
source_dir="$(realpath -e -- "${RELEASE_SOURCE_DIR:-$(dirname -- "${manifest}")}")"
[[ -f "${manifest}" && ! -L "${manifest}" ]] || die "manifest must be a regular non-symlink file: ${manifest}"
[[ -d "${source_dir}/mods" && ! -L "${source_dir}/mods" ]] || die "release mods directory is missing or is a symlink: ${source_dir}/mods"

# The same shape rules reconcile-release.sh enforces before trusting a manifest.
jq -e '
  .schema_version == 1 and
  (.game | type == "string" and test("^[a-z0-9][a-z0-9-]{0,31}$")) and
  (.release | type == "string" and test("^[0-9]+\\.[0-9]+$")) and
  (.source_profile.id | type == "string" and test("^[a-z0-9][a-z0-9-]{0,31}$")) and
  (if .game == "factorio"
    then (.runtime.image | type == "string" and test("^[A-Za-z0-9._/-]+(:[A-Za-z0-9._-]+)?@sha256:[0-9a-f]{64}$"))
    else ((has("runtime") | not) or
      (.runtime.image | type == "string" and test("^[A-Za-z0-9._/-]+(:[A-Za-z0-9._-]+)?@sha256:[0-9a-f]{64}$")))
  end) and
  (.server.mods | type == "array") and
  all(.server.mods[];
    (.file | type == "string" and test("^[^/\\\\]+\\.(jar|zip)$")) and
    (.sha256 | type == "string" and test("^[0-9a-f]{64}$")) and
    (.bytes | type == "number" and floor == . and . >= 0)
  ) and
  (([.server.mods[].file] | unique | length) == (.server.mods | length)) and
  ((.server.overrides // []) | type == "array") and
  all((.server.overrides // [])[];
    (.path | type == "string" and length > 0 and (startswith("/") | not) and (contains("\\") | not) and
      (split("/") | all(. != "" and . != "." and . != "..")) and
      (split("/")[0] | IN("config", "defaultconfigs", "kubejs", "scripts", "global_packs", "openloader"))) and
    (.sha256 | type == "string" and test("^[0-9a-f]{64}$")) and
    (.bytes | type == "number" and floor == . and . >= 0)
  ) and
  (([(.server.overrides // [])[].path] | unique | length) == ((.server.overrides // []) | length)) and
  ((has("client") | not) or (
    .client.file == "client.zip" and .client.kind == "curseforge-modpack" and
    (.client.sha256 | type == "string" and test("^[0-9a-f]{64}$")) and
    (.client.bytes | type == "number" and floor == . and . > 0)
  ) or (
    # The players mod set (ADR-0069): a name the server also carries is the
    # same file, stored once with the server mods.
    .client.kind == "mod-set" and
    (.client.mods | type == "array" and length > 0) and
    all(.client.mods[];
      (.file | type == "string" and test("^[^/\\\\]+\\.(jar|zip)$")) and
      (.sha256 | type == "string" and test("^[0-9a-f]{64}$")) and
      (.bytes | type == "number" and floor == . and . >= 0)
    ) and
    (([.client.mods[].file] | unique | length) == (.client.mods | length)) and
    ((.server.mods | map({key: .file, value: .sha256}) | from_entries) as $server |
      all(.client.mods[]; ($server[.file] // .sha256) == .sha256))
  ))
' "${manifest}" >/dev/null || die "invalid release manifest: ${manifest}"

release="$(jq -r '.release' "${manifest}")"
mods_count="$(jq -r '.server.mods | length' "${manifest}")"
overrides_count="$(jq -r '(.server.overrides // []) | length' "${manifest}")"
client_kind="$(jq -r '.client.kind // empty' "${manifest}")"
client_mods_count="$(jq -r 'if .client.kind == "mod-set" then .client.mods | length else 0 end' "${manifest}")"
game="$(jq -r '.game // "minecraft"' "${manifest}")"
preset_id="$(jq -r '.source_profile.id' "${manifest}")"
release_prefix="releases/${game}/${preset_id}/${release}"
pack_key="${release_prefix}/client.zip"
# Checked here rather than at pack time: a missing zip must fail before the
# payload is uploaded, so a run cannot leave a published release with no pack.
require_command zip
manifest_key="${release_prefix}/manifest.json"
# The hex SHA-256 of one file, as manifests record it.
file_sha256() {
  local file="$1" digest
  digest="$(sha256sum -- "${file}")"
  printf '%s' "${digest%% *}"
}

manifest_digest="$(file_sha256 "${manifest}")"

head_release_object() {
  local key="$1"
  s3_cli head-object \
    --bucket "${RELEASE_BUCKET}" \
    --key "${key}" \
    --checksum-mode ENABLED \
    --query '[Metadata.sha256,ChecksumSHA256,ContentLength]' \
    --output text
}

upload_release_object() {
  local key="$1" body="$2" digest="$3" filename="$4"
  local digest_base64 bytes metadata head_output remote_hex remote_base64 remote_bytes
  digest_base64="$(archive_checksum_base64 "${body}")"
  bytes="$(stat --format '%s' -- "${body}")"
  metadata="$(jq -cn \
    --arg sha256 "${digest}" \
    --arg release "${release}" \
    --arg game "${game}" \
    --arg preset "${preset_id}" \
    --arg file "${filename}" \
    '{sha256: $sha256, game: $game, preset: $preset, release: $release, file: $file}')"

  s3_cli put-object \
    --bucket "${RELEASE_BUCKET}" \
    --key "${key}" \
    --body "${body}" \
    --checksum-algorithm SHA256 \
    --checksum-sha256 "${digest_base64}" \
    --metadata "${metadata}" \
    >/dev/null

  head_output="$(head_release_object "${key}")" || die "could not inspect uploaded object: s3://${RELEASE_BUCKET}/${key}"
  IFS=$'\t' read -r remote_hex remote_base64 remote_bytes <<<"${head_output}"
  [[ "${remote_hex}" == "${digest}" && "${remote_base64}" == "${digest_base64}" && "${remote_bytes}" == "${bytes}" ]] ||
    die "uploaded object failed verification: s3://${RELEASE_BUCKET}/${key}"
}

# The client pack: the release's own mod files as a zip, installed by wholesale
# replacement, which is what prevents duplicate-mod crashes (ADR-0013). Every
# game whose players keep mods locally gets one. Factorio normally hands its
# mods to joining clients itself, but that path is not always available — a
# client that cannot reach the mod portal, or whose sync fails, still needs the
# exact files — and the release already holds them, so the pack costs a zip.
# The install instruction is the game's, because the folder and the rules are.
# An existing pack is left alone rather than digest-compared: zips are not
# byte-reproducible (embedded mtimes), and release immutability is already
# enforced by the manifest gate.
write_install_notes() {
  local target="$1" game_version loader_type loader_version
  game_version="$(jq -r '.minecraft_version' "${manifest}")"
  case "${game}" in
    minecraft)
      loader_type="$(jq -r '.loader.type' "${manifest}")"
      loader_version="$(jq -r '.loader.version' "${manifest}")"
      cat >"${target}" <<EOF
Spawnpoint pack, release ${release} (Minecraft ${game_version}, ${loader_type} ${loader_version}).

1. Delete your mods folder ENTIRELY. Do not merge, do not pick files.
2. Unzip this archive in its place.

Wholesale replacement is what prevents duplicate-mod crashes: nothing old survives.
EOF
      ;;
    factorio)
      cat >"${target}" <<EOF
Spawnpoint pack, release ${release} (Factorio ${game_version}).

Usually you do not need this: joining the server offers the mods it runs. Use the pack when that
offer does not arrive, or when your game cannot reach the mod portal.

1. Close Factorio.
2. Delete every .zip in your mods folder. Leave mod-list.json alone; the game rewrites it.
3. Copy the .zip files from this archive into that folder:
     Windows  %APPDATA%\Factorio\mods
     Linux    ~/.factorio/mods
     macOS    ~/Library/Application Support/factorio/mods

Two versions of one mod stop the game from loading, which is why step 2 is a deletion and not a merge.
EOF
      ;;
    zomboid)
      cat >"${target}" <<EOF
Spawnpoint pack, release ${release} (Project Zomboid build ${game_version}).

Vanilla releases contain no client-side files. Workshop-backed presets will
publish their exact client installation contract here when that resolver lands.
EOF
      ;;
    *)
      die "no install notes for game: ${game}"
      ;;
  esac
}

publish_pack() {
  if head_release_object "${pack_key}" >/dev/null 2>&1; then
    printf 'already_present'
    return 0
  fi

  local pack_dir pack_zip pack_digest expected_bytes
  if [[ "${client_kind}" == "curseforge-modpack" ]]; then
    pack_zip="${source_dir}/client.zip"
    [[ -f "${pack_zip}" && ! -L "${pack_zip}" ]] || die "release client pack is missing or is a symlink"
    pack_digest="$(file_sha256 "${pack_zip}")"
    expected_bytes="$(jq -r '.client.bytes' "${manifest}")"
    [[ "${pack_digest}" == "$(jq -r '.client.sha256' "${manifest}")" && "$(stat --format '%s' -- "${pack_zip}")" == "${expected_bytes}" ]] ||
      die "release client pack does not match the manifest"
    upload_release_object "${pack_key}" "${pack_zip}" "${pack_digest}" "client.zip"
    printf 'uploaded'
    return 0
  fi

  pack_dir="$(mktemp -d)"
  pack_zip="${pack_dir}/pack.zip"
  mkdir -p -- "${pack_dir}/pack"
  if [[ "${client_kind}" == "mod-set" ]]; then
    # The players set, every file held to the manifest's digest: the pack is
    # what players install. A shared mod may be found with the server's.
    local filename expected_sha candidate
    while IFS=$'\t' read -r filename expected_sha; do
      candidate="${source_dir}/client-mods/${filename}"
      [[ -f "${candidate}" ]] || candidate="${source_dir}/mods/${filename}"
      [[ -f "${candidate}" && ! -L "${candidate}" ]] || die "players mod is missing or is a symlink: ${filename}"
      [[ "$(file_sha256 "${candidate}")" == "${expected_sha}" ]] ||
        die "SHA-256 mismatch for players mod ${filename}"
      cp -- "${candidate}" "${pack_dir}/pack/${filename}"
    done < <(jq -r '.client.mods[] | [.file, .sha256] | @tsv' "${manifest}")
  else
    while IFS= read -r filename; do
      cp -- "${source_dir}/mods/${filename}" "${pack_dir}/pack/${filename}"
    done < <(jq -r '.server.mods[].file' "${manifest}")
  fi
  write_install_notes "${pack_dir}/pack/INSTALL.txt"

  (cd "${pack_dir}/pack" && zip -qr "${pack_zip}" .)
  pack_digest="$(file_sha256 "${pack_zip}")"
  upload_release_object "${pack_key}" "${pack_zip}" "${pack_digest}" "pack.zip"
  rm -rf -- "${pack_dir}"
  printf 'uploaded'
}

# A release with its own players set (ADR-0069) also offers the server's set
# and every mod together. They are built here because no request can zip
# hundreds of megabytes; each is published once and its files are held to the
# manifest's digests. A shared file is stored with the server's mods.
publish_set_pack() {
  local name="$1" title="$2" filter="$3" key pack_dir pack_zip pack_digest filename expected_sha candidate
  key="${release_prefix}/${name}.zip"
  if head_release_object "${key}" >/dev/null 2>&1; then
    printf 'already_present'
    return 0
  fi
  pack_dir="$(mktemp -d)"
  pack_zip="${pack_dir}/${name}.zip"
  mkdir -p -- "${pack_dir}/pack"
  while IFS=$'\t' read -r filename expected_sha; do
    candidate="${source_dir}/mods/${filename}"
    [[ -f "${candidate}" ]] || candidate="${source_dir}/client-mods/${filename}"
    [[ -f "${candidate}" && ! -L "${candidate}" ]] || die "${name} pack file is missing or is a symlink: ${filename}"
    [[ "$(file_sha256 "${candidate}")" == "${expected_sha}" ]] ||
      die "SHA-256 mismatch for ${name} pack file ${filename}"
    cp -- "${candidate}" "${pack_dir}/pack/${filename}"
  done < <(jq -r "${filter}" "${manifest}")
  printf '%s\n' "${title}" >"${pack_dir}/pack/README.txt"
  (cd "${pack_dir}/pack" && zip -qr "${pack_zip}" .)
  pack_digest="$(file_sha256 "${pack_zip}")"
  upload_release_object "${key}" "${pack_zip}" "${pack_digest}" "${name}.zip"
  rm -rf -- "${pack_dir}"
  printf 'uploaded'
}

publish_set_packs() {
  server_pack_result=not_applicable
  full_pack_result=not_applicable
  [[ "${client_kind}" == "mod-set" ]] || return 0
  server_pack_result="$(publish_set_pack server \
    "Spawnpoint ${preset_id} release ${release}: every mod the server runs. Players install the client pack." \
    '.server.mods[] | [.file, .sha256] | @tsv')"
  full_pack_result="$(publish_set_pack full \
    "Spawnpoint ${preset_id} release ${release}: every mod, server and players together. Players install the client pack." \
    '([.server.mods[], .client.mods[]] | unique_by(.file))[] | [.file, .sha256] | @tsv')"
}

# An existing manifest is the immutability gate. Identity is the deployment
# content — release, versions and the mods entries — not the whole document:
# created_at and the changelog are descriptive, and two imports of the same
# pack legitimately differ there (see server/releases/README.md).
canonical_manifest() {
  local manifest_file="$1"
  jq -S '{game: (.game // "minecraft"), release, minecraft_version, loader, runtime, server, client}' "${manifest_file}"
}

if head_release_object "${manifest_key}" >/dev/null 2>&1; then
  remote_manifest="$(mktemp)"
  trap 'rm -f -- "${remote_manifest}"' EXIT
  s3_cli get-object \
    --bucket "${RELEASE_BUCKET}" \
    --key "${manifest_key}" \
    "${remote_manifest}" >/dev/null || die "could not fetch the existing manifest: s3://${RELEASE_BUCKET}/${manifest_key}"
  [[ "$(canonical_manifest "${manifest}")" == "$(canonical_manifest "${remote_manifest}")" ]] ||
    die "release ${release} already exists with different content: s3://${RELEASE_BUCKET}/${manifest_key}"
  pack_result="$(publish_pack)"
  publish_set_packs
  printf 'result=already_present\n'
  printf 'bucket=%s\n' "${RELEASE_BUCKET}"
  printf 'release=%s\n' "${release}"
  printf 'manifest_key=%s\n' "${manifest_key}"
  printf 'mods=%s\n' "${mods_count}"
  printf 'overrides=%s\n' "${overrides_count}"
printf 'client_mods=%s\n' "${client_mods_count}"
  printf 'pack=%s\n' "${pack_result}"
  printf 'pack_key=%s\n' "${pack_key}"
printf 'server_pack=%s\n' "${server_pack_result}"
printf 'full_pack=%s\n' "${full_pack_result}"
  exit 0
fi

# A modpack can contain thousands of small configs. Keep the per-object
# checksum/HEAD contract, but avoid serial round trips dominating the build.
upload_jobs=()
await_uploads() {
  local job failed=false
  for job in "${upload_jobs[@]}"; do
    wait "${job}" || failed=true
  done
  upload_jobs=()
  [[ "${failed}" == false ]] || die "release payload publication failed"
}
queue_upload() {
  upload_release_object "$@" &
  upload_jobs+=("$!")
  if (( ${#upload_jobs[@]} == 8 )); then
    await_uploads
  fi
}
# If validation fails with a batch in flight, let its readers finish before
# the caller removes the staged payload. No manifest is committed on failure.
finish_uploads() {
  local exit_status=$?
  wait || true
  return "${exit_status}"
}
trap finish_uploads EXIT

while IFS=$'\t' read -r filename expected_sha expected_bytes; do
  source_file="${source_dir}/mods/${filename}"
  [[ -f "${source_file}" && ! -L "${source_file}" ]] || die "release file is missing or is a symlink: ${source_file}"

  actual_bytes="$(stat --format '%s' -- "${source_file}")"
  [[ "${actual_bytes}" == "${expected_bytes}" ]] || die "size mismatch for ${filename}: expected ${expected_bytes}, got ${actual_bytes}"
  actual_sha="$(sha256sum -- "${source_file}")"
  actual_sha="${actual_sha%% *}"
  [[ "${actual_sha}" == "${expected_sha}" ]] || die "SHA-256 mismatch for ${filename}"

  queue_upload "${release_prefix}/mods/${filename}" "${source_file}" "${expected_sha}" "${filename}"
done < <(jq -r '.server.mods[] | [.file, .sha256, (.bytes | tostring)] | @tsv' "${manifest}")

while IFS=$'\t' read -r path expected_sha expected_bytes; do
  source_file="${source_dir}/overrides/${path}"
  [[ -f "${source_file}" && ! -L "${source_file}" ]] || die "release override is missing or is a symlink: ${source_file}"
  actual_bytes="$(stat --format '%s' -- "${source_file}")"
  [[ "${actual_bytes}" == "${expected_bytes}" ]] || die "size mismatch for override ${path}"
  actual_sha="$(sha256sum -- "${source_file}")"
  actual_sha="${actual_sha%% *}"
  [[ "${actual_sha}" == "${expected_sha}" ]] || die "SHA-256 mismatch for override ${path}"
  queue_upload "${release_prefix}/overrides/${path}" "${source_file}" "${expected_sha}" "$(basename -- "${path}")"
done < <(jq -r '(.server.overrides // [])[] | [.path, .sha256, (.bytes | tostring)] | @tsv' "${manifest}")

# A players mod the server does not run is stored beside the server mods, so a
# single file can be handed out by its digest (ADR-0065) whichever set holds it.
while IFS=$'\t' read -r filename expected_sha expected_bytes; do
  source_file="${source_dir}/client-mods/${filename}"
  [[ -f "${source_file}" && ! -L "${source_file}" ]] || die "players mod is missing or is a symlink: ${source_file}"
  actual_bytes="$(stat --format '%s' -- "${source_file}")"
  [[ "${actual_bytes}" == "${expected_bytes}" ]] || die "size mismatch for players mod ${filename}"
  actual_sha="$(sha256sum -- "${source_file}")"
  actual_sha="${actual_sha%% *}"
  [[ "${actual_sha}" == "${expected_sha}" ]] || die "SHA-256 mismatch for players mod ${filename}"
  queue_upload "${release_prefix}/client-mods/${filename}" "${source_file}" "${expected_sha}" "${filename}"
done < <(jq -r '
  [.server.mods[].file] as $server |
  (if .client.kind == "mod-set" then .client.mods else [] end)[] |
  select(.file as $file | $server | index($file) | not) |
  [.file, .sha256, (.bytes | tostring)] | @tsv' "${manifest}")

await_uploads
pack_result="$(publish_pack)"
publish_set_packs
upload_release_object "${manifest_key}" "${manifest}" "${manifest_digest}" "manifest.json"

printf 'result=uploaded\n'
printf 'bucket=%s\n' "${RELEASE_BUCKET}"
printf 'release=%s\n' "${release}"
printf 'manifest_key=%s\n' "${manifest_key}"
printf 'mods=%s\n' "${mods_count}"
printf 'overrides=%s\n' "${overrides_count}"
printf 'client_mods=%s\n' "${client_mods_count}"
printf 'pack=%s\n' "${pack_result}"
printf 'pack_key=%s\n' "${pack_key}"
printf 'server_pack=%s\n' "${server_pack_result}"
printf 'full_pack=%s\n' "${full_pack_result}"
