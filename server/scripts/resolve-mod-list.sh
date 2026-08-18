#!/usr/bin/env bash

# Resolve a pinned mod list (<slug>:<fileId> per line, ADR-0028) into a local
# payload directory by downloading each pinned file from CurseForge. Pins are
# immutable file ids, so this is a fetch, not an update check. The payload is a
# cache: files already present with the right SHA-1 and size are kept.
#
# Response shapes follow the documented CurseForge API contract; the first live
# run against the real API is the acceptance test for them.

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_common.sh
source "${SCRIPT_DIR}/_common.sh"

list="${1:-}"
payload_dir="${2:-}"
[[ -n "${list}" && -n "${payload_dir}" ]] || die "usage: resolve-mod-list.sh <mod-list> <payload-directory>"

require_command curl
require_command jq
require_command sha1sum
[[ -n "${CF_API_KEY:-}" ]] || die "CF_API_KEY is required"

api_base="${CF_API_BASE:-https://api.curseforge.com}"
game_id="${CF_GAME_ID:-432}"

list="$(realpath -e -- "${list}")"
payload_dir="$(realpath -m -- "${payload_dir}")"
mkdir -p -- "${payload_dir}/mods"

cf_get() {
  curl -fsSL -H "x-api-key: ${CF_API_KEY}" "$1"
}

resolved=0
downloaded=0
kept=0
while IFS= read -r line; do
  entry="${line%%#*}"
  entry="${entry//[[:space:]]/}"
  [[ -n "${entry}" ]] || continue

  [[ "${entry}" =~ ^([a-z0-9][a-z0-9-]*):([0-9]+)$ ]] || die "unparseable mod list entry: ${line}"
  slug="${BASH_REMATCH[1]}"
  file_id="${BASH_REMATCH[2]}"

  search_json="$(cf_get "${api_base}/v1/mods/search?gameId=${game_id}&slug=${slug}")" ||
    die "CurseForge search failed for slug ${slug}"
  mod_id="$(jq -r --arg slug "${slug}" '[.data[] | select(.slug == $slug)][0].id // empty' <<<"${search_json}")"
  [[ "${mod_id}" =~ ^[0-9]+$ ]] || die "no CurseForge mod found for slug ${slug}"

  file_json="$(cf_get "${api_base}/v1/mods/${mod_id}/files/${file_id}")" ||
    die "CurseForge file lookup failed for ${slug}:${file_id}"
  file_name="$(jq -r '.data.fileName // empty' <<<"${file_json}")"
  file_bytes="$(jq -r '.data.fileLength // empty' <<<"${file_json}")"
  download_url="$(jq -r '.data.downloadUrl // empty' <<<"${file_json}")"
  sha1_expected="$(jq -r '[.data.hashes[]? | select(.algo == 1)][0].value // empty' <<<"${file_json}")"

  [[ "${file_name}" =~ ^[A-Za-z0-9][A-Za-z0-9._+-]*\.jar$ ]] || die "unsafe or non-JAR file name from the API for ${slug}:${file_id}: ${file_name}"
  [[ "${file_bytes}" =~ ^[0-9]+$ ]] || die "no file length from the API for ${slug}:${file_id}"
  [[ "${sha1_expected}" =~ ^[0-9a-f]{40}$ ]] || die "no SHA-1 from the API for ${slug}:${file_id}"
  [[ -n "${download_url}" ]] ||
    die "the author of ${slug} has disabled API downloads for file ${file_id}; fetch it by hand into the payload and re-run"

  resolved=$((resolved + 1))
  target="${payload_dir}/mods/${file_name}"

  if [[ -f "${target}" && ! -L "${target}" ]]; then
    actual_sha1="$(sha1sum -- "${target}")"
    actual_sha1="${actual_sha1%% *}"
    if [[ "${actual_sha1}" == "${sha1_expected}" && "$(stat --format '%s' -- "${target}")" == "${file_bytes}" ]]; then
      kept=$((kept + 1))
      continue
    fi
    log "cached ${file_name} does not match the pinned file; refetching"
    rm -f -- "${target}"
  fi

  fetch_tmp="$(mktemp "${payload_dir}/mods/.${file_name}.XXXXXX")"
  curl -fsSL -H "x-api-key: ${CF_API_KEY}" -o "${fetch_tmp}" "${download_url}" || {
    rm -f -- "${fetch_tmp}"
    die "download failed for ${slug}:${file_id}"
  }
  actual_sha1="$(sha1sum -- "${fetch_tmp}")"
  actual_sha1="${actual_sha1%% *}"
  [[ "${actual_sha1}" == "${sha1_expected}" && "$(stat --format '%s' -- "${fetch_tmp}")" == "${file_bytes}" ]] || {
    rm -f -- "${fetch_tmp}"
    die "downloaded ${file_name} does not match the pinned SHA-1 and size"
  }
  mv -- "${fetch_tmp}" "${target}"
  downloaded=$((downloaded + 1))
done <"${list}"

(( resolved > 0 )) || die "the mod list contains no entries: ${list}"

printf 'result=resolved\n'
printf 'payload=%s\n' "${payload_dir}"
printf 'resolved=%s\n' "${resolved}"
printf 'downloaded=%s\n' "${downloaded}"
printf 'kept=%s\n' "${kept}"
