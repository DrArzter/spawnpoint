#!/usr/bin/env bash

# A world's own config files (ADR-0093), written into its data folder after the
# release's files, so the world's version wins. Each file is read from the
# release bucket by its digest beside the world's record, checked against that
# digest, and placed only inside the game's config roots.
#
# usage: apply-world-config.sh <world-data-directory> <game-id> <world-id> <config-files-json>
# Prints result=none|applied and config_files=<count>.

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_common.sh
source "${SCRIPT_DIR}/_common.sh"
# shellcheck source=../games/_manifest.sh
source "${SCRIPT_DIR}/../games/_manifest.sh"

[[ $# -eq 4 ]] || die "usage: apply-world-config.sh <world-data-directory> <game-id> <world-id> <config-files-json>"
data_dir="$(realpath -e -- "$1")"
game_id="$2"
world_id="$3"
files="$4"
[[ -d "${data_dir}" && ! -L "${data_dir}" ]] || die "world data directory is missing or unsafe"
[[ "${world_id}" =~ ^[a-z0-9][a-z0-9-]{0,31}$ ]] || die "invalid world id: ${world_id}"
jq -e 'type == "object" and all(.[]; type == "string" and test("^[0-9a-f]{64}$"))' <<<"${files}" >/dev/null ||
  die "invalid config files: ${files}"

count="$(jq 'length' <<<"${files}")"
if (( count == 0 )); then
  printf 'result=none\nconfig_files=0\n'
  exit 0
fi

roots="$(game_fact "${game_id}" '.config_files.roots // []')"
[[ "${roots}" != "[]" ]] || die "${game_id} keeps no config files, but world ${world_id} names ${count}"
[[ -n "${RELEASE_BUCKET:-}" ]] || die "RELEASE_BUCKET is required"

stage="$(mktemp -d)"
trap 'rm -rf -- "${stage}"' EXIT

while IFS=$'\t' read -r path digest; do
  jq -e --arg path "${path}" --argjson roots "${roots}" -n '
    ($path | split("/")) as $parts |
    ($parts | length) >= 2 and ($parts | length) <= 8 and ($parts[0] | IN($roots[])) and
    all($parts[]; test("^[A-Za-z0-9._+-][A-Za-z0-9 ._+-]{0,127}$") and . != "." and . != ".." and (startswith(".") | not))
  ' >/dev/null || die "config file outside the game's config roots: ${path}"

  # Every folder on the way is a real folder, so a link cannot carry the write outside the world.
  folder="${data_dir}"
  IFS='/' read -r -a parts <<<"${path}"
  for part in "${parts[@]:0:${#parts[@]}-1}"; do
    folder="${folder}/${part}"
    [[ ! -L "${folder}" ]] || die "config path runs through a symbolic link: ${path}"
    [[ -d "${folder}" ]] || mkdir -- "${folder}"
  done
  target="${data_dir}/${path}"
  [[ ! -L "${target}" && ! -d "${target}" ]] || die "config file target is not a regular file: ${path}"

  aws s3api get-object --bucket "${RELEASE_BUCKET}" --key "worlds/${world_id}/config/${digest}" "${stage}/file" >/dev/null
  actual="$(sha256sum -- "${stage}/file")"
  [[ "${actual%% *}" == "${digest}" ]] || die "config file ${path} does not match its digest"
  install -m 0644 -- "${stage}/file" "${target}.spawnpoint-next"
  chown --reference="${data_dir}" -- "${target}.spawnpoint-next" 2>/dev/null || true
  mv -f -- "${target}.spawnpoint-next" "${target}"
done < <(jq -r 'to_entries[] | [.key, .value] | @tsv' <<<"${files}")

printf 'result=applied\nconfig_files=%s\n' "${count}"
