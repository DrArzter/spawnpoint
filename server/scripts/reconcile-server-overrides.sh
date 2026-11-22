#!/usr/bin/env bash

# Replace the release-managed Minecraft configuration roots while leaving save
# data and operator-owned files alone. Every source byte is verified before the
# first live path moves; a failed multi-root swap restores the previous roots.
# The world_data paths a release declares (ADR-0077) are world-owned: they move
# from each old root into its replacement, and are never deleted.

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_common.sh
source "${SCRIPT_DIR}/_common.sh"

manifest="${1:-}"
target_data="${2:-${SPAWNPOINT_WORLD_DATA_DIRECTORY:-}}"
[[ -n "${manifest}" && -n "${target_data}" ]] ||
  die "usage: reconcile-server-overrides.sh <manifest.json> <world-data-directory>"

require_command flock
require_command jq
require_command sha256sum

manifest="$(realpath -e -- "${manifest}")"
source_dir="$(realpath -e -- "${RELEASE_SOURCE_DIR:-$(dirname -- "${manifest}")}")"
target_data="$(realpath -m -- "${target_data}")"
[[ -f "${manifest}" && ! -L "${manifest}" ]] || die "manifest must be a regular file"
[[ -d "${source_dir}/overrides" && ! -L "${source_dir}/overrides" ]] || die "release overrides directory is missing or unsafe"
[[ "${target_data}" != "/" && "$(dirname -- "${target_data}")" != "/" ]] || die "refusing world data at the filesystem root"
[[ -d "${target_data}" && ! -L "${target_data}" ]] || die "world data directory is missing or unsafe"

world_data_path='type == "string" and (test("[\\t\\n\\\\]") | not) and
  test("^(config|defaultconfigs|kubejs|scripts|global_packs|openloader)(/[^/]+)+$") and
  (split("/") | all(. != "." and . != ".."))'

jq -e "
  ((.server.overrides // []) | type == \"array\") and
  all((.server.overrides // [])[];
    (.path | type == \"string\" and length > 0 and (startswith(\"/\") | not) and (contains(\"\\\\\") | not) and
      (split(\"/\") | all(. != \"\" and . != \".\" and . != \"..\")) and
      (split(\"/\")[0] | IN(\"config\", \"defaultconfigs\", \"kubejs\", \"scripts\", \"global_packs\", \"openloader\"))) and
    (.sha256 | type == \"string\" and test(\"^[0-9a-f]{64}\$\")) and
    (.bytes | type == \"number\" and floor == . and . >= 0)
  ) and
  (([(.server.overrides // [])[].path] | unique | length) == ((.server.overrides // []) | length)) and
  ((.server.world_data // []) | type == \"array\" and all(.[]; ${world_data_path}))
" "${manifest}" >/dev/null || die "invalid server overrides in release manifest"

release="$(jq -r '.release' "${manifest}")"
marker="${target_data}/.spawnpoint-overrides.json"
current_roots="$(jq -c '[((.server.overrides // [])[].path | split("/")[0])] | unique | sort' "${manifest}")"
previous_roots='[]'
previous_world_data='[]'
if [[ -e "${marker}" || -L "${marker}" ]]; then
  [[ -f "${marker}" && ! -L "${marker}" ]] || die "override marker is unsafe"
  previous_roots="$(jq -ce '.roots | arrays' "${marker}")" || die "override marker is invalid"
  previous_world_data="$(jq -ce "(.world_data // []) | select(type == \"array\" and all(.[]; ${world_data_path}))" "${marker}")" ||
    die "override marker has invalid world_data"
fi
all_roots="$(jq -cn --argjson current "${current_roots}" --argjson previous "${previous_roots}" '$current + $previous | unique | sort')"
# A path stays world data once a release declared it: a later release that
# ships a file there stops the start, and nothing is changed or deleted.
kept_world_data="$(jq -c --argjson previous "${previous_world_data}" '(.server.world_data // []) + $previous | unique | sort' "${manifest}")"
conflict="$(jq -r --argjson kept "${kept_world_data}" '
  def overlaps($a; $b): $a == $b or ($a | startswith($b + "/")) or ($b | startswith($a + "/"));
  first($kept[] as $path | (.server.overrides // [])[] | select(overlaps(.path; $path)) | "\(.path) (world data: \($path))") // empty
' "${manifest}")"
[[ -z "${conflict}" ]] ||
  die "release ${release} ships a file where the world keeps its own data: ${conflict}; nothing was changed"

# Only paths below a root this run replaces need to move.
mapfile -t moving_world_data < <(jq -r --argjson roots "${all_roots}" '.[] | select(split("/")[0] | IN($roots[]))' <<<"${kept_world_data}")
for path in "${moving_world_data[@]}"; do
  # Every folder above the path must be a real folder: a symbolic link would
  # move data from outside the world.
  ancestor="${target_data}"
  IFS='/' read -r -a components <<<"${path}"
  for component in "${components[@]:0:${#components[@]}-1}"; do
    ancestor="${ancestor}/${component}"
    [[ ! -L "${ancestor}" ]] || die "world data path runs through a symbolic link: ${ancestor}"
    [[ ! -e "${ancestor}" || -d "${ancestor}" ]] || die "world data path runs through a file: ${ancestor}"
  done
done

parent="$(dirname -- "${target_data}")"
name="$(basename -- "${target_data}")"
lock_file="${parent}/.spawnpoint-${name}.overrides.lock"
exec 9>"${lock_file}"
flock -n 9 || die "another reconciliation is changing server overrides"

stage="$(mktemp -d "${parent}/.${name}.${release}.overrides.XXXXXXXX")"
backup="$(mktemp -d "${parent}/.${name}.${release}.previous.XXXXXXXX")"
swapped=false
committed=false
moved_world_data=()
# Live roots already moved into the backup, in case a later root cannot move.
moved_roots=()
cleanup() {
  status=$?
  local restore_failed=false root path root_failed
  if [[ "${swapped}" != true && "${committed}" != true ]]; then
    for root in "${moved_roots[@]}"; do
      if [[ -e "${target_data}/${root}" || -L "${target_data}/${root}" ]] ||
        ! mv -T -- "${backup}/${root}" "${target_data}/${root}"; then
        printf 'error: could not put %s back into %s\n' "${root}" "${target_data}" >&2
        restore_failed=true
      fi
    done
  fi
  if [[ "${swapped}" == true && "${committed}" != true ]]; then
    while IFS= read -r root; do
      # World data goes back into the old root before the new root is removed.
      root_failed=false
      for path in "${moved_world_data[@]}"; do
        [[ "${path%%/*}" == "${root}" ]] || continue
        mkdir -p -- "$(dirname -- "${backup}/${path}")" || { root_failed=true; continue; }
        if [[ -e "${stage}/${path}" || -L "${stage}/${path}" ]]; then
          mv -T -- "${stage}/${path}" "${backup}/${path}" || root_failed=true
        elif [[ -e "${target_data}/${path}" || -L "${target_data}/${path}" ]]; then
          mv -T -- "${target_data}/${path}" "${backup}/${path}" || root_failed=true
        fi
      done
      if [[ "${root_failed}" == true ]]; then
        printf 'error: could not return the world data of %s; nothing more is changed\n' "${root}" >&2
        restore_failed=true
        continue
      fi
      rm -rf -- "${target_data:?}/${root}"
      if [[ -e "${backup}/${root}" ]] && ! mv -T -- "${backup}/${root}" "${target_data}/${root}"; then
        printf 'error: could not put %s back into %s\n' "${root}" "${target_data}" >&2
        restore_failed=true
      fi
    done < <(jq -r '.[]' <<<"${all_roots}")
  fi
  # Never delete a backup that may still hold a live root or its world data.
  if [[ "${restore_failed}" == true ]]; then
    printf 'error: world data may be in %s or %s; both are kept\n' "${stage}" "${backup}" >&2
    (( status != 0 )) || status=1
  else
    rm -rf -- "${stage}" "${backup}"
  fi
  exit "${status}"
}
trap cleanup EXIT

while IFS=$'\t' read -r path expected_sha expected_bytes; do
  source_file="${source_dir}/overrides/${path}"
  [[ -f "${source_file}" && ! -L "${source_file}" ]] || die "release override is missing or unsafe: ${path}"
  actual_sha="$(sha256sum -- "${source_file}")"
  actual_sha="${actual_sha%% *}"
  [[ "${actual_sha}" == "${expected_sha}" && "$(stat --format '%s' -- "${source_file}")" == "${expected_bytes}" ]] ||
    die "release override failed verification: ${path}"
  destination="${stage}/${path}"
  mkdir -p -- "$(dirname -- "${destination}")"
  cp -- "${source_file}" "${destination}"
  chmod 0644 -- "${destination}"
done < <(jq -r '(.server.overrides // [])[] | [.path, .sha256, (.bytes | tostring)] | @tsv' "${manifest}")

while IFS= read -r root; do
  live="${target_data}/${root}"
  [[ ! -L "${live}" ]] || die "managed override root is a symbolic link: ${live}"
  if [[ -e "${live}" ]]; then
    [[ -d "${live}" ]] || die "managed override root is not a directory: ${live}"
    mv -- "${live}" "${backup}/${root}" || die "cannot move managed override root: ${live}"
    moved_roots+=("${root}")
  fi
done < <(jq -r '.[]' <<<"${all_roots}")
swapped=true

# Sorted, so a folder moves before any path inside it; that path then moves
# with it.
for path in "${moving_world_data[@]}"; do
  [[ -e "${backup}/${path}" || -L "${backup}/${path}" ]] || continue
  [[ ! -e "${stage}/${path}" && ! -L "${stage}/${path}" ]] || die "world data path is also in the release: ${path}"
  mkdir -p -- "$(dirname -- "${stage}/${path}")" || die "cannot keep world data path: ${path}"
  moved_world_data+=("${path}")
  mv -T -- "${backup}/${path}" "${stage}/${path}" || die "cannot keep world data path: ${path}"
done

# The game runs as its own user and rewrites some of these files at boot (a
# mod's config). The image hands /data to that user only while /data is not
# yet its own, so a second start on the same host met root-owned files and the
# server failed with AccessDeniedException. Running as root, the new roots go
# to the game user before they are live.
if ((EUID == 0)); then
  game_owner="${GAME_DATA_OWNER:-1000:1000}"
  [[ "${game_owner}" =~ ^[0-9]+:[0-9]+$ ]] || die "GAME_DATA_OWNER must be uid:gid: ${game_owner}"
  while IFS= read -r root; do
    [[ ! -d "${stage}/${root}" ]] || chown -R -- "${game_owner}" "${stage}/${root}"
  done < <(jq -r '.[]' <<<"${all_roots}")
fi

while IFS= read -r root; do
  [[ ! -d "${stage}/${root}" ]] || mv -- "${stage}/${root}" "${target_data}/${root}"
done < <(jq -r '.[]' <<<"${all_roots}")

jq -n \
  --arg release "${release}" \
  --argjson roots "${current_roots}" \
  --argjson world_data "${kept_world_data}" \
  '{schema_version: 1, release: $release, roots: $roots} + if ($world_data | length) == 0 then {} else {world_data: $world_data} end' \
  >"${stage}/marker.json"
chmod 0644 -- "${stage}/marker.json"
mv -- "${stage}/marker.json" "${marker}"
committed=true

printf 'result=reconciled\n'
printf 'release=%s\n' "${release}"
printf 'roots=%s\n' "$(jq -r 'length' <<<"${current_roots}")"
printf 'files=%s\n' "$(jq -r '(.server.overrides // []) | length' "${manifest}")"
printf 'world_data=%s\n' "${#moved_world_data[@]}"
