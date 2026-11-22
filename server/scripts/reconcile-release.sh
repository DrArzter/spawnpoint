#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_common.sh
source "${SCRIPT_DIR}/_common.sh"

usage() {
  cat >&2 <<'EOF'
usage: reconcile-release.sh <manifest.json> [target-mod-directory]

The release payload defaults to the manifest's directory and must contain mods/<file>.
Override it with RELEASE_SOURCE_DIR when the manifest and payload have been staged separately.
EOF
}

[[ $# -ge 1 && $# -le 2 ]] || {
  usage
  exit 2
}

require_command jq
require_command sha256sum
require_command flock

manifest="$(realpath -e -- "$1")"
source_dir="$(realpath -e -- "${RELEASE_SOURCE_DIR:-$(dirname -- "${manifest}")}")"
target_dir="$(realpath -m -- "${2:-${SERVER_MODS_DIR:-${SERVER_DIR}/mods}}")"
target_parent="$(dirname -- "${target_dir}")"
target_name="$(basename -- "${target_dir}")"

[[ -f "${manifest}" && ! -L "${manifest}" ]] || die "manifest must be a regular non-symlink file: ${manifest}"
[[ -d "${source_dir}/mods" && ! -L "${source_dir}/mods" ]] || die "release mods directory is missing or is a symlink: ${source_dir}/mods"
[[ "${target_dir}" != "/" && "${target_parent}" != "/" ]] || die "refusing a target at the filesystem root: ${target_dir}"
[[ "${target_dir}" != "${source_dir}" && "${target_dir}" != "${source_dir}/mods" ]] || die "target must not replace its own release source: ${target_dir}"
if [[ "${target_name}" != "mods" && "${RECONCILE_ALLOW_NON_MODS_TARGET:-false}" != "true" ]]; then
  die "target directory must be named mods (set RECONCILE_ALLOW_NON_MODS_TARGET=true only for a disposable test)"
fi
[[ ! -e "${target_dir}" || -d "${target_dir}" ]] || die "target exists and is not a directory: ${target_dir}"
mkdir -p -- "${target_parent}"
[[ ! -L "${target_dir}" ]] || die "target mod directory must not be a symlink: ${target_dir}"

if ! jq -e '
  .schema_version == 1 and
  (.release | type == "string" and test("^[0-9]+\\.[0-9]+$")) and
  (.minecraft_version | type == "string" and length > 0) and
  (((.game // "minecraft") == "minecraft" and (.loader.type | IN("vanilla", "forge", "neoforge", "fabric", "quilt"))) or
   ((.game // "minecraft") == "factorio" and .loader.type == "factorio")) and
  (.loader.version | type == "string" and length > 0) and
  (if (.game // "minecraft") == "factorio"
    then (.runtime.image | type == "string" and test("^[A-Za-z0-9._/-]+(:[A-Za-z0-9._-]+)?@sha256:[0-9a-f]{64}$"))
    else ((has("runtime") | not) or
      (.runtime.image | type == "string" and test("^[A-Za-z0-9._/-]+(:[A-Za-z0-9._-]+)?@sha256:[0-9a-f]{64}$")))
  end) and
  (.created_at | type == "string" and length > 0) and
  (.created_by | type == "string" and length > 0) and
  (.changelog | type == "string") and
  (.server.mods | type == "array") and
  all(.server.mods[];
    (.file | type == "string" and test("^[^/\\\\]+\\.(jar|zip)$")) and
    (.sha256 | type == "string" and test("^[0-9a-f]{64}$")) and
    (.bytes | type == "number" and floor == . and . >= 0)
  ) and
  (([.server.mods[].file] | unique | length) == (.server.mods | length)) and
  ((has("source_profile") | not) or (
    (.source_profile.id | type == "string" and test("^[a-z0-9][a-z0-9-]{0,31}$")) and
    (.source_profile.repository | type == "string" and length > 0) and
    (.source_profile.commit | type == "string" and test("^[0-9a-f]{40}$"))
  ))
' "${manifest}" >/dev/null; then
  die "invalid release manifest: ${manifest}"
fi

release="$(jq -r '.release' "${manifest}")"
expected_count="$(jq -r '.server.mods | length' "${manifest}")"
lock_file="${target_parent}/.spawnpoint-${target_name}.reconcile.lock"
exec 9>"${lock_file}"
flock -n 9 || die "another reconciliation is already changing ${target_dir}"

stage_dir="$(mktemp -d "${target_parent}/.${target_name}.${release}.stage.XXXXXX")"
# mktemp deliberately creates 0700. The directory becomes a container bind
# mount after the atomic rename, so the non-root Minecraft user needs search
# permission while release payloads remain read-only.
chmod 0755 -- "${stage_dir}"
backup_dir="${target_parent}/.${target_name}.${release}.previous.$$"
target_moved=false
committed=false
# The world's own subfolders of the mods directory (ADR-0010), moved into the
# stage before the swap so that a release change keeps them.
kept_folders=()
# Put every kept folder back into the old mods directory. A folder that cannot
# go back stays in the stage, which is then kept.
return_kept_folders() {
  local folder failed=false
  for folder in "${kept_folders[@]}"; do
    [[ -e "${stage_dir}/${folder}" || -L "${stage_dir}/${folder}" ]] || continue
    if [[ -e "${target_dir}/${folder}" || -L "${target_dir}/${folder}" ]] || ! mv -T -- "${stage_dir}/${folder}" "${target_dir}/${folder}"; then
      printf 'error: could not put %s back into %s; it is kept in %s\n' "${folder}" "${target_dir}" "${stage_dir}" >&2
      failed=true
    fi
  done
  [[ "${failed}" == false ]]
}
holds_folder() {
  [[ -d "$1" && -n "$(find "$1" -mindepth 1 -maxdepth 1 -type d -print -quit)" ]]
}
cleanup() {
  status=$?
  if [[ "${committed}" != true ]]; then
    if [[ "${target_moved}" == true && ! -e "${target_dir}" && -d "${backup_dir}" ]]; then
      mv -- "${backup_dir}" "${target_dir}"
    fi
    if [[ -d "${target_dir}" && ! -L "${target_dir}" ]]; then
      return_kept_folders || status=1
    fi
  fi
  # Never delete a folder of world data: a stage or a previous directory that
  # still holds one is kept for the operator.
  if holds_folder "${stage_dir}"; then
    printf 'error: the stage still holds world data; kept at %s\n' "${stage_dir}" >&2
    (( status != 0 )) || status=1
  else
    rm -rf -- "${stage_dir}"
  fi
  if [[ "${committed}" == true ]]; then
    if holds_folder "${backup_dir}"; then
      printf 'warning: the previous mods directory still holds a folder; kept at %s\n' "${backup_dir}" >&2
    else
      rm -rf -- "${backup_dir}"
    fi
  fi
  exit "${status}"
}
trap cleanup EXIT

while IFS=$'\t' read -r filename expected_sha expected_bytes; do
  source_file="${source_dir}/mods/${filename}"
  [[ -f "${source_file}" && ! -L "${source_file}" ]] || die "release file is missing or is a symlink: ${source_file}"

  actual_bytes="$(stat --format '%s' -- "${source_file}")"
  [[ "${actual_bytes}" == "${expected_bytes}" ]] || die "size mismatch for ${filename}: expected ${expected_bytes}, got ${actual_bytes}"

  # One hash per file: the staged copy is what the game reads, so it is the
  # copy that is held to the manifest.
  cp --reflink=auto --preserve=mode,timestamps -- "${source_file}" "${stage_dir}/${filename}"
  chmod 0644 -- "${stage_dir}/${filename}"
  copied_sha="$(sha256sum -- "${stage_dir}/${filename}")"
  copied_sha="${copied_sha%% *}"
  [[ "${copied_sha}" == "${expected_sha}" ]] || die "SHA-256 mismatch for ${filename}"
done < <(jq -r '.server.mods[] | [.file, .sha256, (.bytes | tostring)] | @tsv' "${manifest}")

actual_count="$(find "${stage_dir}" -maxdepth 1 -type f \( -name '*.jar' -o -name '*.zip' \) | wc -l)"
[[ "${actual_count}" == "${expected_count}" ]] || die "staged mod count mismatch: expected ${expected_count}, got ${actual_count}"
cp -- "${manifest}" "${stage_dir}/.spawnpoint-release.json"
chmod 0644 -- "${stage_dir}/.spawnpoint-release.json"

if [[ -d "${target_dir}" ]]; then
  mapfile -d '' world_folders < <(find "${target_dir}" -mindepth 1 -maxdepth 1 -type d -printf '%f\0' | sort -z)
  # Every name is checked before the first folder moves.
  for folder in "${world_folders[@]}"; do
    [[ ! -e "${stage_dir}/${folder}" && ! -L "${stage_dir}/${folder}" ]] ||
      die "the release ships ${folder}, which is a folder of world data in ${target_dir}"
  done
  for folder in "${world_folders[@]}"; do
    kept_folders+=("${folder}")
    mv -T -- "${target_dir}/${folder}" "${stage_dir}/${folder}" ||
      die "could not move ${folder} out of ${target_dir}; every folder is put back"
  done
fi

if [[ -e "${target_dir}" ]]; then
  mv -- "${target_dir}" "${backup_dir}"
  target_moved=true
fi
mv -- "${stage_dir}" "${target_dir}"
committed=true

printf 'result=reconciled\n'
printf 'release=%s\n' "${release}"
printf 'mods=%s\n' "${expected_count}"
printf 'kept_folders=%s\n' "${#kept_folders[@]}"
printf 'target=%s\n' "${target_dir}"
