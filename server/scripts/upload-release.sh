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
  (.server.mods | type == "array") and
  all(.server.mods[];
    (.file | type == "string" and test("^[^/\\\\]+\\.(jar|zip)$")) and
    (.sha256 | type == "string" and test("^[0-9a-f]{64}$")) and
    (.bytes | type == "number" and floor == . and . >= 0)
  ) and
  (([.server.mods[].file] | unique | length) == (.server.mods | length))
' "${manifest}" >/dev/null || die "invalid release manifest: ${manifest}"

release="$(jq -r '.release' "${manifest}")"
mods_count="$(jq -r '.server.mods | length' "${manifest}")"
game="$(jq -r '.game // "minecraft"' "${manifest}")"
preset_id="$(jq -r '.source_profile.id' "${manifest}")"
release_prefix="releases/${game}/${preset_id}/${release}"
pack_key="${release_prefix}/client.zip"
# Checked here rather than at pack time: a missing zip must fail before the
# payload is uploaded, so a run cannot leave a published release with no pack.
require_command zip
manifest_key="${release_prefix}/manifest.json"
manifest_digest="$(sha256sum -- "${manifest}" | awk '{print $1}')"

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

  local pack_dir pack_zip pack_digest
  pack_dir="$(mktemp -d)"
  pack_zip="${pack_dir}/pack.zip"
  mkdir -p -- "${pack_dir}/pack"
  while IFS= read -r filename; do
    cp -- "${source_dir}/mods/${filename}" "${pack_dir}/pack/${filename}"
  done < <(jq -r '.server.mods[].file' "${manifest}")
  write_install_notes "${pack_dir}/pack/INSTALL.txt"

  (cd "${pack_dir}/pack" && zip -qr "${pack_zip}" .)
  pack_digest="$(sha256sum -- "${pack_zip}" | awk '{print $1}')"
  upload_release_object "${pack_key}" "${pack_zip}" "${pack_digest}" "pack.zip"
  rm -rf -- "${pack_dir}"
  printf 'uploaded'
}

# An existing manifest is the immutability gate. Identity is the deployment
# content — release, versions and the mods entries — not the whole document:
# created_at and the changelog are descriptive, and two imports of the same
# pack legitimately differ there (see server/releases/README.md).
canonical_manifest() {
  jq -S '{game: (.game // "minecraft"), release, minecraft_version, loader, server}' "$1"
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
  printf 'result=already_present\n'
  printf 'bucket=%s\n' "${RELEASE_BUCKET}"
  printf 'release=%s\n' "${release}"
  printf 'manifest_key=%s\n' "${manifest_key}"
  printf 'mods=%s\n' "${mods_count}"
  printf 'pack=%s\n' "${pack_result}"
  printf 'pack_key=%s\n' "${pack_key}"
  exit 0
fi

while IFS=$'\t' read -r filename expected_sha expected_bytes; do
  source_file="${source_dir}/mods/${filename}"
  [[ -f "${source_file}" && ! -L "${source_file}" ]] || die "release file is missing or is a symlink: ${source_file}"

  actual_bytes="$(stat --format '%s' -- "${source_file}")"
  [[ "${actual_bytes}" == "${expected_bytes}" ]] || die "size mismatch for ${filename}: expected ${expected_bytes}, got ${actual_bytes}"
  actual_sha="$(sha256sum -- "${source_file}")"
  actual_sha="${actual_sha%% *}"
  [[ "${actual_sha}" == "${expected_sha}" ]] || die "SHA-256 mismatch for ${filename}"

  upload_release_object "${release_prefix}/mods/${filename}" "${source_file}" "${expected_sha}" "${filename}"
done < <(jq -r '.server.mods[] | [.file, .sha256, (.bytes | tostring)] | @tsv' "${manifest}")

upload_release_object "${manifest_key}" "${manifest}" "${manifest_digest}" "manifest.json"
pack_result="$(publish_pack)"

printf 'result=uploaded\n'
printf 'bucket=%s\n' "${RELEASE_BUCKET}"
printf 'release=%s\n' "${release}"
printf 'manifest_key=%s\n' "${manifest_key}"
printf 'mods=%s\n' "${mods_count}"
printf 'pack=%s\n' "${pack_result}"
printf 'pack_key=%s\n' "${pack_key}"
