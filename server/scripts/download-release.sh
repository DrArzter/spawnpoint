#!/usr/bin/env bash

# Ensure a complete, verified copy of a release exists in a local payload
# directory. The payload is a cache on the data volume: files already present
# with the right digest are kept, missing or mismatched ones are fetched and
# re-verified — so a tampered or half-written cache heals itself, and an
# ordinary boot after no mod change downloads nothing.

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_common.sh
source "${SCRIPT_DIR}/_common.sh"
# shellcheck source=_s3.sh
source "${SCRIPT_DIR}/_s3.sh"

game="${1:-}"
preset_id="${2:-}"
release="${3:-}"
payload_dir="${4:-}"
[[ -n "${game}" && -n "${preset_id}" && -n "${release}" && -n "${payload_dir}" ]] || die "usage: download-release.sh <game> <preset> <release> <payload-directory>"

require_command aws
require_command jq
require_command sha256sum
[[ -n "${RELEASE_BUCKET:-}" ]] || die "RELEASE_BUCKET is required"
[[ "${game}" =~ ^[a-z0-9][a-z0-9-]{0,31}$ ]] || die "invalid game id: ${game}"
[[ "${preset_id}" =~ ^[a-z0-9][a-z0-9-]{0,31}$ ]] || die "invalid preset id: ${preset_id}"
[[ "${release}" =~ ^[0-9]+\.[0-9]+$ ]] || die "release must use MAJOR.MINOR: ${release}"

payload_dir="$(realpath -m -- "${payload_dir}")"
mkdir -p -- "${payload_dir}/mods" "${payload_dir}/overrides"
[[ ! -L "${payload_dir}/mods" && ! -L "${payload_dir}/overrides" ]] || die "release cache contains a symbolic-link payload root"
if find "${payload_dir}/overrides" -mindepth 1 -type l -print -quit | grep -q .; then
  die "release cache contains a symbolic-link override"
fi

release_prefix="releases/${game}/${preset_id}/${release}"
manifest_key="${release_prefix}/manifest.json"
manifest_tmp="$(mktemp "${payload_dir}/.manifest.XXXXXX")"
cleanup() {
  rm -f -- "${manifest_tmp}"
}
trap cleanup EXIT

# The manifest is fetched fresh every time: it is small, and it is the truth
# the rest of the payload is judged against.
s3_cli get-object \
  --bucket "${RELEASE_BUCKET}" \
  --key "${manifest_key}" \
  "${manifest_tmp}" >/dev/null || die "release ${release} is not published: s3://${RELEASE_BUCKET}/${manifest_key}"

jq -e '
  .schema_version == 1 and
  (.game | type == "string") and
  (.release | type == "string") and
  (.source_profile.id | type == "string") and
  (if .game == "factorio"
    then (.runtime.image | type == "string" and test("^[A-Za-z0-9._/-]+(:[A-Za-z0-9._-]+)?@sha256:[0-9a-f]{64}$"))
    else ((has("runtime") | not) or
      (.runtime.image | type == "string" and test("^[A-Za-z0-9._/-]+(:[A-Za-z0-9._-]+)?@sha256:[0-9a-f]{64}$")))
  end) and
  (.server.mods | type == "array") and
  all(.server.mods[];
    (.file | type == "string" and test("^[^/\\\\]+\\.(jar|zip)$")) and
    (.sha256 | type == "string" and test("^[0-9a-f]{64}$")) and
    (.bytes | type == "number")
  ) and
  ((.server.overrides // []) | type == "array") and
  all((.server.overrides // [])[];
    (.path | type == "string" and length > 0 and (startswith("/") | not) and (contains("\\") | not) and
      (split("/") | all(. != "" and . != "." and . != "..")) and
      (split("/")[0] | IN("config", "defaultconfigs", "kubejs", "scripts", "global_packs", "openloader"))) and
    (.sha256 | type == "string" and test("^[0-9a-f]{64}$")) and
    (.bytes | type == "number" and floor == . and . >= 0)
  )
' "${manifest_tmp}" >/dev/null || die "invalid manifest for release ${release}"
[[ "$(jq -r '.release' "${manifest_tmp}")" == "${release}" ]] || die "manifest names a different release"
[[ "$(jq -r '.game' "${manifest_tmp}")" == "${game}" ]] || die "manifest names a different game"
[[ "$(jq -r '.source_profile.id' "${manifest_tmp}")" == "${preset_id}" ]] || die "manifest names a different preset"

downloaded=0
kept=0
while IFS=$'\t' read -r filename expected_sha expected_bytes; do
  target="${payload_dir}/mods/${filename}"

  if [[ -f "${target}" && ! -L "${target}" ]]; then
    actual_sha="$(sha256sum -- "${target}")"
    actual_sha="${actual_sha%% *}"
    if [[ "${actual_sha}" == "${expected_sha}" && "$(stat --format '%s' -- "${target}")" == "${expected_bytes}" ]]; then
      kept=$((kept + 1))
      continue
    fi
    log "cached ${filename} does not match the manifest; refetching"
    rm -f -- "${target}"
  fi

  fetch_tmp="$(mktemp "${payload_dir}/mods/.${filename}.XXXXXX")"
  s3_cli get-object \
    --bucket "${RELEASE_BUCKET}" \
    --key "${release_prefix}/mods/${filename}" \
    "${fetch_tmp}" >/dev/null || {
    rm -f -- "${fetch_tmp}"
    die "could not download ${filename} for release ${release}"
  }
  actual_sha="$(sha256sum -- "${fetch_tmp}")"
  actual_sha="${actual_sha%% *}"
  [[ "${actual_sha}" == "${expected_sha}" ]] || {
    rm -f -- "${fetch_tmp}"
    die "downloaded ${filename} failed verification against the manifest"
  }
  mv -- "${fetch_tmp}" "${target}"
  downloaded=$((downloaded + 1))
done < <(jq -r '.server.mods[] | [.file, .sha256, (.bytes | tostring)] | @tsv' "${manifest_tmp}")

while IFS=$'\t' read -r path expected_sha expected_bytes; do
  target="${payload_dir}/overrides/${path}"
  mkdir -p -- "$(dirname -- "${target}")"
  if [[ -f "${target}" && ! -L "${target}" ]]; then
    actual_sha="$(sha256sum -- "${target}")"
    actual_sha="${actual_sha%% *}"
    if [[ "${actual_sha}" == "${expected_sha}" && "$(stat --format '%s' -- "${target}")" == "${expected_bytes}" ]]; then
      kept=$((kept + 1))
      continue
    fi
    log "cached override ${path} does not match the manifest; refetching"
    rm -f -- "${target}"
  fi
  [[ ! -e "${target}" && ! -L "${target}" ]] || die "unsafe cached override path: ${target}"
  fetch_tmp="$(mktemp "$(dirname -- "${target}")/.override.XXXXXX")"
  s3_cli get-object \
    --bucket "${RELEASE_BUCKET}" \
    --key "${release_prefix}/overrides/${path}" \
    "${fetch_tmp}" >/dev/null || {
    rm -f -- "${fetch_tmp}"
    die "could not download override ${path} for release ${release}"
  }
  actual_sha="$(sha256sum -- "${fetch_tmp}")"
  actual_sha="${actual_sha%% *}"
  [[ "${actual_sha}" == "${expected_sha}" && "$(stat --format '%s' -- "${fetch_tmp}")" == "${expected_bytes}" ]] || {
    rm -f -- "${fetch_tmp}"
    die "downloaded override ${path} failed verification against the manifest"
  }
  mv -- "${fetch_tmp}" "${target}"
  downloaded=$((downloaded + 1))
done < <(jq -r '(.server.overrides // [])[] | [.path, .sha256, (.bytes | tostring)] | @tsv' "${manifest_tmp}")

mv -- "${manifest_tmp}" "${payload_dir}/manifest.json"
trap - EXIT

printf 'result=release_ready\n'
printf 'game=%s\n' "${game}"
printf 'preset=%s\n' "${preset_id}"
printf 'release=%s\n' "${release}"
printf 'payload=%s\n' "${payload_dir}"
printf 'downloaded=%s\n' "${downloaded}"
printf 'kept=%s\n' "${kept}"
