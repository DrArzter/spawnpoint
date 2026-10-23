#!/usr/bin/env bash

# Replace the release-managed Minecraft configuration roots while leaving save
# data and operator-owned files alone. Every source byte is verified before the
# first live path moves; a failed multi-root swap restores the previous roots.

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

jq -e '
  ((.server.overrides // []) | type == "array") and
  all((.server.overrides // [])[];
    (.path | type == "string" and length > 0 and (startswith("/") | not) and (contains("\\") | not) and
      (split("/") | all(. != "" and . != "." and . != "..")) and
      (split("/")[0] | IN("config", "defaultconfigs", "kubejs", "scripts", "global_packs", "openloader"))) and
    (.sha256 | type == "string" and test("^[0-9a-f]{64}$")) and
    (.bytes | type == "number" and floor == . and . >= 0)
  ) and
  (([(.server.overrides // [])[].path] | unique | length) == ((.server.overrides // []) | length))
' "${manifest}" >/dev/null || die "invalid server overrides in release manifest"

release="$(jq -r '.release' "${manifest}")"
marker="${target_data}/.spawnpoint-overrides.json"
current_roots="$(jq -c '[((.server.overrides // [])[].path | split("/")[0])] | unique | sort' "${manifest}")"
previous_roots='[]'
if [[ -e "${marker}" || -L "${marker}" ]]; then
  [[ -f "${marker}" && ! -L "${marker}" ]] || die "override marker is unsafe"
  previous_roots="$(jq -ce '.roots | arrays' "${marker}")" || die "override marker is invalid"
fi
all_roots="$(jq -cn --argjson current "${current_roots}" --argjson previous "${previous_roots}" '$current + $previous | unique | sort')"

parent="$(dirname -- "${target_data}")"
name="$(basename -- "${target_data}")"
lock_file="${parent}/.spawnpoint-${name}.overrides.lock"
exec 9>"${lock_file}"
flock -n 9 || die "another reconciliation is changing server overrides"

stage="$(mktemp -d "${parent}/.${name}.${release}.overrides.XXXXXXXX")"
backup="$(mktemp -d "${parent}/.${name}.${release}.previous.XXXXXXXX")"
swapped=false
committed=false
cleanup() {
  status=$?
  if [[ "${swapped}" == true && "${committed}" != true ]]; then
    while IFS= read -r root; do
      rm -rf -- "${target_data:?}/${root}"
      [[ ! -e "${backup}/${root}" ]] || mv -- "${backup}/${root}" "${target_data}/${root}"
    done < <(jq -r '.[]' <<<"${all_roots}")
  fi
  rm -rf -- "${stage}" "${backup}"
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
    mv -- "${live}" "${backup}/${root}"
  fi
done < <(jq -r '.[]' <<<"${all_roots}")
swapped=true

while IFS= read -r root; do
  [[ ! -d "${stage}/${root}" ]] || mv -- "${stage}/${root}" "${target_data}/${root}"
done < <(jq -r '.[]' <<<"${current_roots}")

jq -n \
  --arg release "${release}" \
  --argjson roots "${current_roots}" \
  '{schema_version: 1, release: $release, roots: $roots}' >"${stage}/marker.json"
chmod 0644 -- "${stage}/marker.json"
mv -- "${stage}/marker.json" "${marker}"
committed=true

printf 'result=reconciled\n'
printf 'release=%s\n' "${release}"
printf 'roots=%s\n' "$(jq -r 'length' <<<"${current_roots}")"
printf 'files=%s\n' "$(jq -r '(.server.overrides // []) | length' "${manifest}")"
