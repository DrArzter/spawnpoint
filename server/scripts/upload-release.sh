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

# shellcheck source=../games/_legacy-game.sh
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/../games/_legacy-game.sh"

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_common.sh
source "${SCRIPT_DIR}/_common.sh"
# shellcheck source=_s3.sh
source "${SCRIPT_DIR}/_s3.sh"

manifest="${1:-}"
[[ -n "${manifest}" ]] || die "usage: upload-release.sh <manifest.json> (payload defaults to the manifest's directory; override with RELEASE_SOURCE_DIR)"

# The storage layout (ADR-0080). `legacy` is today's per-release keys and the
# default; `objects-v1` writes content-addressed objects through the writer and
# stays off until the readers are deployed.
storage_layout="${RELEASE_STORAGE_LAYOUT:-legacy}"
case "${storage_layout}" in
  legacy | objects-v1) ;;
  *) die "RELEASE_STORAGE_LAYOUT must be legacy or objects-v1: ${storage_layout}" ;;
esac

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
  # world_data (ADR-0077): below a managed root, and clear of every shipped file.
  ((.server | has("world_data") | not) or (
    (.server.world_data | type == "array" and length > 0 and length == (unique | length)) and
    all(.server.world_data[]; type == "string" and (test("[\\t\\n\\\\]") | not) and
      test("^(config|defaultconfigs|kubejs|scripts|global_packs|openloader)(/[^/]+)+$") and
      (split("/") | all(. != "." and . != ".."))) and
    ([.server.world_data[] as $path | (.server.overrides // [])[] |
      select(.path == $path or (.path | startswith($path + "/")) or ($path | startswith(.path + "/")))] | length == 0))) and
  # mod_index (ADR-0077) is descriptive: SHA-256 to mod ids, outside the identity gate.
  ((has("mod_index") | not) or (.mod_index | type == "object" and all(to_entries[];
    (.key | test("^[0-9a-f]{64}$")) and (.value | type == "array" and all(.[]; type == "string"))))) and
  ((has("client") | not) or (
    .client.file == "client.zip" and .client.kind == "curseforge-modpack" and
    (.client.sha256 | type == "string" and test("^[0-9a-f]{64}$")) and
    (.client.bytes | type == "number" and floor == . and . > 0) and
    # Addons (ADR-0077): both and server addons are server mods with the same
    # digest; a client addon is a file of its own, never a server name.
    ((.client | has("addons") | not) or (
      (.client.addons | type == "array" and length > 0) and
      all(.client.addons[];
        (.file | type == "string" and test("^[^/\\\\]+\\.jar$")) and
        (.sha256 | type == "string" and test("^[0-9a-f]{64}$")) and
        (.bytes | type == "number" and floor == . and . > 0) and
        (.side | IN("both", "server", "client"))) and
      (([.client.addons[].file] | unique | length) == (.client.addons | length)) and
      ((.server.mods | map({key: .file, value: .sha256}) | from_entries) as $server |
        all(.client.addons[]; if .side == "client" then $server[.file] == null else $server[.file] == .sha256 end))))
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
client_mods_count="$(jq -r 'if .client.kind == "mod-set" then .client.mods | length else [(.client.addons // [])[] | select(.side == "client")] | length end' "${manifest}")"
game="$(jq -r --arg legacy_game "${LEGACY_GAME_ID}" '.game // $legacy_game' "${manifest}")"
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

# Stores one object and confirms it from the put-object response. S3 returns
# ChecksumSHA256 only after it validated the bytes against the checksum we sent,
# so the response proves the stored bytes. A third argument "head" adds the
# head-object read-back (metadata, checksum and size) for single large objects.
upload_release_object() {
  local key="$1" body="$2" digest="$3" filename="$4" confirm="${5:-response}"
  local digest_base64 bytes metadata put_checksum head_output remote_hex remote_base64 remote_bytes
  digest_base64="$(archive_checksum_base64 "${body}")"
  metadata="$(jq -cn \
    --arg sha256 "${digest}" \
    --arg release "${release}" \
    --arg game "${game}" \
    --arg preset "${preset_id}" \
    --arg file "${filename}" \
    '{sha256: $sha256, game: $game, preset: $preset, release: $release, file: $file}')"

  put_checksum="$(s3_cli put-object \
    --bucket "${RELEASE_BUCKET}" \
    --key "${key}" \
    --body "${body}" \
    --checksum-algorithm SHA256 \
    --checksum-sha256 "${digest_base64}" \
    --metadata "${metadata}" \
    --query ChecksumSHA256 \
    --output text)" || die "upload failed: s3://${RELEASE_BUCKET}/${key}"
  [[ "${put_checksum}" == "${digest_base64}" ]] ||
    die "upload not confirmed by S3: s3://${RELEASE_BUCKET}/${key}"
  [[ "${confirm}" == head ]] || return 0

  bytes="$(stat --format '%s' -- "${body}")"
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

# The files of the client pack, with the install notes, in <directory>. Both
# layouts stage the same files; only the zip and the place of the bytes differ.
stage_client_pack() {
  local directory="$1" filename expected_sha candidate
  mkdir -p -- "${directory}"
  if [[ "${client_kind}" == "mod-set" ]]; then
    # The players set, every file held to the manifest's digest: the pack is
    # what players install. A shared mod may be found with the server's.
    while IFS=$'\t' read -r filename expected_sha; do
      candidate="${source_dir}/client-mods/${filename}"
      [[ -f "${candidate}" ]] || candidate="${source_dir}/mods/${filename}"
      [[ -f "${candidate}" && ! -L "${candidate}" ]] || die "players mod is missing or is a symlink: ${filename}"
      [[ "$(file_sha256 "${candidate}")" == "${expected_sha}" ]] ||
        die "SHA-256 mismatch for players mod ${filename}"
      cp -- "${candidate}" "${directory}/${filename}"
    done < <(jq -r '.client.mods[] | [.file, .sha256] | @tsv' "${manifest}")
  else
    while IFS= read -r filename; do
      cp -- "${source_dir}/mods/${filename}" "${directory}/${filename}"
    done < <(jq -r '.server.mods[].file' "${manifest}")
  fi
  write_install_notes "${directory}/INSTALL.txt"
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
    upload_release_object "${pack_key}" "${pack_zip}" "${pack_digest}" "client.zip" head
    printf 'uploaded'
    return 0
  fi

  pack_dir="$(mktemp -d)"
  pack_zip="${pack_dir}/pack.zip"
  stage_client_pack "${pack_dir}/pack"

  (cd "${pack_dir}/pack" && zip -qr "${pack_zip}" .)
  pack_digest="$(file_sha256 "${pack_zip}")"
  upload_release_object "${pack_key}" "${pack_zip}" "${pack_digest}" "pack.zip" head
  rm -rf -- "${pack_dir}"
  printf 'uploaded'
}

# The files of a server or full pack, with its README, in <directory>.
stage_set_pack() {
  local directory="$1" name="$2" title="$3" filter="$4" filename expected_sha candidate
  mkdir -p -- "${directory}"
  while IFS=$'\t' read -r filename expected_sha; do
    candidate="${source_dir}/mods/${filename}"
    [[ -f "${candidate}" ]] || candidate="${source_dir}/client-mods/${filename}"
    [[ -f "${candidate}" && ! -L "${candidate}" ]] || die "${name} pack file is missing or is a symlink: ${filename}"
    [[ "$(file_sha256 "${candidate}")" == "${expected_sha}" ]] ||
      die "SHA-256 mismatch for ${name} pack file ${filename}"
    cp -- "${candidate}" "${directory}/${filename}"
  done < <(jq -r "${filter}" "${manifest}")
  printf '%s\n' "${title}" >"${directory}/README.txt"
}

set_pack_title_server="Spawnpoint ${preset_id} release ${release}: every mod the server runs. Players install the client pack."
set_pack_title_full="Spawnpoint ${preset_id} release ${release}: every mod, server and players together. Players install the client pack."
set_pack_filter_server='.server.mods[] | [.file, .sha256] | @tsv'
set_pack_filter_full='([.server.mods[], .client.mods[]] | unique_by(.file))[] | [.file, .sha256] | @tsv'

# A release with its own players set (ADR-0069) also offers the server's set
# and every mod together. They are built here because no request can zip
# hundreds of megabytes; each is published once and its files are held to the
# manifest's digests. A shared file is stored with the server's mods.
publish_set_pack() {
  local name="$1" title="$2" filter="$3" key pack_dir pack_zip pack_digest
  key="${release_prefix}/${name}.zip"
  if head_release_object "${key}" >/dev/null 2>&1; then
    printf 'already_present'
    return 0
  fi
  pack_dir="$(mktemp -d)"
  pack_zip="${pack_dir}/${name}.zip"
  stage_set_pack "${pack_dir}/pack" "${name}" "${title}" "${filter}"
  (cd "${pack_dir}/pack" && zip -qr "${pack_zip}" .)
  pack_digest="$(file_sha256 "${pack_zip}")"
  upload_release_object "${key}" "${pack_zip}" "${pack_digest}" "${name}.zip" head
  rm -rf -- "${pack_dir}"
  printf 'uploaded'
}

publish_set_packs() {
  server_pack_result=not_applicable
  full_pack_result=not_applicable
  [[ "${client_kind}" == "mod-set" ]] || return 0
  server_pack_result="$(publish_set_pack server "${set_pack_title_server}" "${set_pack_filter_server}")"
  full_pack_result="$(publish_set_pack full "${set_pack_title_full}" "${set_pack_filter_full}")"
}

# The release plan (plan-release.sh), when the caller made one. It is
# descriptive and outside the gate: written after the payload and just before
# the manifest, and a failure here never stops the publication.
plan_key="${release_prefix}/plan.json"
plan_result=not_provided
publish_plan() {
  local plan="${RELEASE_PLAN:-}"
  [[ -n "${plan}" ]] || return 0
  if [[ -f "${plan}" && ! -L "${plan}" ]] &&
    jq -e --arg release "${release}" --arg preset "${preset_id}" \
      '.schema_version == 1 and .release == $release and .preset == $preset' "${plan}" >/dev/null 2>&1 &&
    (upload_release_object "${plan_key}" "${plan}" "$(file_sha256 "${plan}")" "plan.json"); then
    plan_result=uploaded
  else
    plan_result=failed
    log "warning: the release plan was not published; the release is unaffected"
  fi
}

# --- objects-v1 (ADR-0080) ------------------------------------------------
# The payload goes through the writer: one long-lived Node process with a
# bounded worker pool. One aws CLI process for each object reached only 1.9
# objects/s on BUILD_GENERAL1_SMALL (2 vCPU, measured), and a modpack has about
# 1,700 objects. The writer keeps the S3 checksum confirmation of this script.
# The manifest still goes last, with one put: its existence is the commit marker.
writer_command=()
object_pack_args=()
objects_work=""
prepare_object_writer() {
  if [[ -n "${RELEASE_WRITER_BIN:-}" ]]; then
    # Tests point the script at a stub; the value is a command line.
    read -r -a writer_command <<<"${RELEASE_WRITER_BIN}"
  else
    require_command node
    [[ -f "${SCRIPT_DIR}/../../tools/release-writer.cjs" ]] || die "RELEASE_STORAGE_LAYOUT=objects-v1 needs the release writer bundle (tools/release-writer.cjs)"
    writer_command=(node "${SCRIPT_DIR}/../../tools/release-writer.cjs")
  fi
  build_id="${RELEASE_BUILD_ID:-}"
  [[ -n "${build_id}" ]] || build_id="local-$(cat /proc/sys/kernel/random/uuid 2>/dev/null || date +%s)-$$"
  objects_work="$(mktemp -d)"
}

# Prints the writer's result lines; a failure ends this script.
run_writer() {
  local command="$1" output
  output="$(RELEASE_BUCKET="${RELEASE_BUCKET}" "${writer_command[@]}" "$@")" || die "release writer failed: ${command}"
  [[ -z "${output}" ]] || printf '%s\n' "${output}"
}

# The same files give the same zip, so a rebuild stores no new pack object: a
# fixed mtime, a fixed mode and a sorted entry list.
zip_reproducible() {
  local directory="$1" archive="$2"
  find "${directory}" -type f -exec chmod 0644 {} +
  find "${directory}" -exec touch -h -t 198001010000 {} +
  (cd "${directory}" && find . -type f -printf '%P\n' | LC_ALL=C sort | zip -X -q "${archive}" -@)
}

# Fills object_pack_args. A modpack's client pack is the payload's client.zip,
# which the writer checks against client.sha256; every other pack is built here.
build_object_packs() {
  local work="$1"
  object_pack_args=()
  if [[ "${client_kind}" == "curseforge-modpack" ]]; then
    [[ -f "${source_dir}/client.zip" && ! -L "${source_dir}/client.zip" ]] || die "release client pack is missing or is a symlink"
    object_pack_args+=(--pack "client=${source_dir}/client.zip")
  else
    stage_client_pack "${work}/client"
    zip_reproducible "${work}/client" "${work}/client.zip"
    object_pack_args+=(--pack "client=${work}/client.zip")
  fi
  if [[ "${client_kind}" == "mod-set" ]]; then
    local name
    for name in server full; do
      local title="set_pack_title_${name}" filter="set_pack_filter_${name}"
      stage_set_pack "${work}/${name}" "${name}" "${!title}" "${!filter}"
      zip_reproducible "${work}/${name}" "${work}/${name}.zip"
      object_pack_args+=(--pack "${name}=${work}/${name}.zip")
    done
  fi
}

# Runs `write` for <manifest-file>; more arguments (--heal) follow it.
write_objects() {
  local manifest_file="$1"
  shift
  local extra=()
  [[ ! "${RELEASE_PROFILE_DIGEST:-}" =~ ^[0-9a-f]{64}$ ]] || extra+=(--profile-digest "${RELEASE_PROFILE_DIGEST}")
  [[ -z "${RELEASE_UPSTREAM_MAP:-}" || ! -s "${RELEASE_UPSTREAM_MAP}" ]] || extra+=(--upstream-map "${RELEASE_UPSTREAM_MAP}")
  run_writer write --manifest "${manifest_file}" --source-dir "${source_dir}" \
    --game "${game}" --preset "${preset_id}" --release "${release}" --build-id "${build_id}" \
    "${object_pack_args[@]}" "${extra[@]}" "$@"
}

publish_objects_release() {
  run_writer publish --game "${game}" --preset "${preset_id}" --release "${release}" --build-id "${build_id}" >/dev/null
}

# The result lines of an objects-v1 release: the legacy names, then the writer's.
print_objects_result() {
  local result="$1" final_manifest="$2" writer_lines="$3" client_digest
  client_digest="$(jq -r '.client.sha256 // .packs.client.sha256 // empty' "${final_manifest}")"
  printf 'result=%s\n' "${result}"
  printf 'bucket=%s\n' "${RELEASE_BUCKET}"
  printf 'release=%s\n' "${release}"
  printf 'manifest_key=%s\n' "${manifest_key}"
  printf 'mods=%s\n' "${mods_count}"
  printf 'overrides=%s\n' "${overrides_count}"
  printf 'client_mods=%s\n' "${client_mods_count}"
  printf 'pack=objects\n'
  [[ -z "${client_digest}" ]] || printf 'pack_key=objects/sha256/%s/%s\n' "${client_digest:0:2}" "${client_digest}"
  if [[ "${client_kind}" == "mod-set" ]]; then
    printf 'server_pack=objects\nfull_pack=objects\n'
  else
    printf 'server_pack=not_applicable\nfull_pack=not_applicable\n'
  fi
  printf 'plan=%s\n' "${plan_result}"
  [[ "${plan_result}" != uploaded ]] || printf 'plan_key=%s\n' "${plan_key}"
  [[ -z "${writer_lines}" ]] || printf '%s\n' "${writer_lines}"
}

# An existing manifest is the immutability gate. Identity is the deployment
# content — release, versions and the mods entries — not the whole document:
# created_at and the changelog are descriptive, and two imports of the same
# pack legitimately differ there (see server/releases/README.md).
canonical_manifest() {
  local manifest_file="$1"
  jq -S --arg legacy_game "${LEGACY_GAME_ID}" '{game: (.game // $legacy_game), release, minecraft_version, loader, runtime, server, client}' "${manifest_file}"
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
  if jq -e '.storage.layout == "objects-v1"' "${remote_manifest}" >/dev/null 2>&1; then
    # An objects-v1 release keeps no pack under its own key: never write one.
    # With the flag on, heal: verify every object, recreate a missing one only
    # from a local file whose digest matches. The stored manifest is kept.
    writer_lines=""
    if [[ "${storage_layout}" == objects-v1 ]]; then
      prepare_object_writer
      trap 'rm -f -- "${remote_manifest}"; rm -rf -- "${objects_work}"' EXIT
      build_object_packs "${objects_work}"
      writer_lines="$(write_objects "${remote_manifest}" --heal)"
      publish_objects_release
    fi
    [[ -z "${RELEASE_PLAN:-}" ]] || plan_result=skipped_existing_release
    print_objects_result already_present "${remote_manifest}" "${writer_lines}"
    exit 0
  fi
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
  # A published release keeps the plan of the build that published it.
  [[ -z "${RELEASE_PLAN:-}" ]] || plan_result=skipped_existing_release
  printf 'plan=%s\n' "${plan_result}"
  exit 0
fi

if [[ "${storage_layout}" == objects-v1 ]]; then
  # The manifest was validated above. Objects first (the writer adds `storage`
  # and `packs` to the manifest once every object is in place), then the plan,
  # then the manifest, then the release goes live.
  prepare_object_writer
  trap 'rm -rf -- "${objects_work}"' EXIT
  build_object_packs "${objects_work}"
  writer_lines="$(write_objects "${manifest}")"
  manifest_digest="$(file_sha256 "${manifest}")"
  publish_plan
  upload_release_object "${manifest_key}" "${manifest}" "${manifest_digest}" "manifest.json" head
  publish_objects_release
  log "release published in ${SECONDS}s"
  print_objects_result uploaded "${manifest}" "${writer_lines}"
  exit 0
fi

# A modpack can contain thousands of small configs, and every aws CLI process
# costs about a second of CPU on a small builder. So each object takes one
# process (no head-object), run in a sliding window: a slot is refilled the
# moment any upload ends, never after the slowest of a batch.
upload_concurrency="${RELEASE_UPLOAD_CONCURRENCY:-16}"
upload_progress_every="${RELEASE_UPLOAD_PROGRESS_EVERY:-100}"
[[ "${upload_concurrency}" =~ ^[1-9][0-9]?$ ]] || die "RELEASE_UPLOAD_CONCURRENCY must be 1 to 99: ${upload_concurrency}"
[[ "${upload_progress_every}" =~ ^[1-9][0-9]*$ ]] || die "RELEASE_UPLOAD_PROGRESS_EVERY must be a positive integer: ${upload_progress_every}"
uploads_running=0
uploads_done=0
upload_started=${SECONDS}
# One finished upload frees its slot. A failed one stops the publication at
# once; the job already named its key, and finish_uploads awaits the rest.
reap_upload() {
  wait -n || die "release payload publication failed after ${uploads_done} objects"
  uploads_running=$((uploads_running - 1))
  uploads_done=$((uploads_done + 1))
  if (( uploads_done % upload_progress_every == 0 )); then
    log "uploaded ${uploads_done} objects in $((SECONDS - upload_started))s"
  fi
}
await_uploads() {
  while (( uploads_running > 0 )); do
    reap_upload
  done
}
queue_upload() {
  while (( uploads_running >= upload_concurrency )); do
    reap_upload
  done
  upload_release_object "$@" &
  uploads_running=$((uploads_running + 1))
}
# If validation fails with uploads in flight, let them finish before the
# caller removes the staged payload. No manifest is committed on failure.
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
  (if .client.kind == "mod-set" then .client.mods else [(.client.addons // [])[] | select(.side == "client")] end)[] |
  select(.file as $file | $server | index($file) | not) |
  [.file, .sha256, (.bytes | tostring)] | @tsv' "${manifest}")

await_uploads
log "payload upload finished: ${uploads_done} objects in $((SECONDS - upload_started))s"
pack_result="$(publish_pack)"
publish_set_packs
publish_plan
upload_release_object "${manifest_key}" "${manifest}" "${manifest_digest}" "manifest.json" head
log "release published in ${SECONDS}s"

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
printf 'plan=%s\n' "${plan_result}"
[[ "${plan_result}" != uploaded ]] || printf 'plan_key=%s\n' "${plan_key}"
