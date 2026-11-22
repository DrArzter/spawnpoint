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
# shellcheck source=_object-cache.sh
source "${SCRIPT_DIR}/_object-cache.sh"

game="${1:-}"
preset_id="${2:-}"
release="${3:-}"
payload_dir="${4:-}"
[[ -n "${game}" && -n "${preset_id}" && -n "${release}" && -n "${payload_dir}" ]] || die "usage: download-release.sh <game> <preset> <release> <payload-directory>"

require_command aws
require_command jq
require_command sha256sum
require_command flock
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

# One download per release at a time. Under the lock, temporary files left by
# a start that was killed (no EXIT trap ran) belong to nobody and are removed.
lock_file="$(dirname -- "${payload_dir}")/.$(basename -- "${payload_dir}").download.lock"
exec 9>"${lock_file}"
flock -w "${DOWNLOAD_LOCK_WAIT_SECONDS:-900}" 9 || die "another download of release ${release} is still running"
rm -rf -- "${payload_dir}"/.fetch.* "${payload_dir}"/.manifest.*
find "${payload_dir}/mods" "${payload_dir}/overrides" -name '.reuse.*' -type f -delete

release_prefix="releases/${game}/${preset_id}/${release}"
manifest_key="${release_prefix}/manifest.json"
manifest_tmp="$(mktemp "${payload_dir}/.manifest.XXXXXX")"
fetch_dir=""
cleanup() {
  rm -f -- "${manifest_tmp}"
  [[ -z "${fetch_dir}" ]] || rm -rf -- "${fetch_dir}"
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
  ((has("storage") | not) or (.storage | type == "object")) and
  (.server.mods | type == "array") and
  all(.server.mods[];
    (.file | type == "string" and test("^[^/\\\\]+\\.(jar|zip)$")) and
    (.sha256 | type == "string" and test("^[0-9a-f]{64}$")) and
    (.bytes | type == "number")
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
  ((.server | has("world_data") | not) or (
    (.server.world_data | type == "array" and length > 0 and length == (unique | length)) and
    all(.server.world_data[]; type == "string" and (test("[\\t\\n\\\\]") | not) and
      test("^(config|defaultconfigs|kubejs|scripts|global_packs|openloader)(/[^/]+)+$") and
      (split("/") | all(. != "." and . != ".."))) and
    ([.server.world_data[] as $path | (.server.overrides // [])[] |
      select(.path == $path or (.path | startswith($path + "/")) or ($path | startswith(.path + "/")))] | length == 0)))
' "${manifest_tmp}" >/dev/null || die "invalid manifest for release ${release}"
[[ "$(jq -r '.release' "${manifest_tmp}")" == "${release}" ]] || die "manifest names a different release"
[[ "$(jq -r '.game' "${manifest_tmp}")" == "${game}" ]] || die "manifest names a different game"
[[ "$(jq -r '.source_profile.id' "${manifest_tmp}")" == "${preset_id}" ]] || die "manifest names a different preset"

layout="legacy"
if [[ "$(jq -r '(.storage // {}) | has("layout")' "${manifest_tmp}")" == "true" ]]; then
  layout="$(jq -r '.storage.layout | if type == "string" then . else "(not a string)" end' "${manifest_tmp}")"
  [[ "${layout}" == "objects-v1" ]] ||
    die "release ${release} uses the storage layout '${layout}', which this host does not know; update the host checkout"
fi

# Exact S3 filter for one key: the CLI reads --include as a glob.
glob_literal() {
  local text="$1" out="" char index
  for ((index = 0; index < ${#text}; index++)); do
    char="${text:index:1}"
    case "${char}" in
      '[' | '*' | '?') out+="[${char}]" ;;
      *) out+="${char}" ;;
    esac
  done
  printf '%s' "${out}"
}

file_matches() {
  local file="$1" expected_sha="$2" expected_bytes="$3" actual_sha
  [[ -f "${file}" && ! -L "${file}" ]] || return 1
  [[ "$(stat --format '%s' -- "${file}")" == "${expected_bytes}" ]] || return 1
  actual_sha="$(sha256sum -- "${file}")"
  [[ "${actual_sha%% *}" == "${expected_sha}" ]]
}

# objects-v1: every file is an object named by its digest. Missing digests are
# fetched once into the shared cache, then the payload is built from the cache.
# Mods are hard links, so a mod costs no second copy. Overrides are copies,
# because a mod rewrites its configs at run time.
download_objects_v1() {
  local sha bytes relative object target tmp fetched_file cache_root
  local -A bytes_of=()
  local -a missing=() filters=()
  downloaded=0
  kept=0
  fetched=0

  cache_root="$(object_cache_root)"
  object_cache_init
  # The cache lock covers the checks and the links, so eviction never removes
  # an object between the two.
  exec 8>"${cache_root}/.cache.lock"
  flock -w "${DOWNLOAD_LOCK_WAIT_SECONDS:-900}" 8 || die "another process is changing the object cache"
  rm -rf -- "${cache_root}"/.fetch.*

  while IFS=$'\t' read -r sha bytes; do
    [[ -z "${bytes_of[${sha}]:-}" || "${bytes_of[${sha}]}" == "${bytes}" ]] ||
      die "manifest of release ${release} names digest ${sha} with two sizes"
    bytes_of["${sha}"]="${bytes}"
  done < <(jq -r '(.server.mods[], (.server.overrides // [])[]) | [.sha256, (.bytes | tostring)] | @tsv' "${manifest_tmp}")

  while read -r sha; do
    bytes="${bytes_of[${sha}]}"
    object="$(object_cache_path "${sha}")"
    object_cache_dir "${sha}"
    if object_cache_trusted "${object}" "${bytes}"; then
      touch -c -- "${object}" 2>/dev/null || true # mtime orders eviction: oldest first
      continue
    fi
    if [[ -f "${object}" && ! -L "${object}" ]]; then
      # Not root-owned 0444: trust it only after the hash agrees.
      if file_matches "${object}" "${sha}" "${bytes}"; then
        chmod 0444 -- "${object}"
        chown 0:0 -- "${object}" 2>/dev/null || true
        continue
      fi
      log "cached object ${sha} does not match its digest; refetching"
      rm -f -- "${object}"
    fi
    [[ ! -e "${object}" && ! -L "${object}" ]] || die "unsafe object cache path: ${object}"
    missing+=("${sha}")
  done < <(printf '%s\n' "${!bytes_of[@]}" | sort)

  if ((${#missing[@]} > 0)); then
    fetch_dir="$(mktemp -d "${cache_root}/.fetch.XXXXXX")"
    filters=(--exclude '*')
    for sha in "${missing[@]}"; do
      filters+=(--include "$(glob_literal "${sha:0:2}/${sha}")")
    done
    aws "${S3_GLOBAL_ARGS[@]}" s3 cp \
      "s3://${RELEASE_BUCKET}/objects/sha256/" "${fetch_dir}/" \
      --recursive --only-show-errors "${filters[@]}" >&2 ||
      die "could not download the objects of release ${release}"

    # The copy does not compare hashes: each object is held to size and digest
    # before it enters the cache, and the host never loads a wrong file.
    for sha in "${missing[@]}"; do
      bytes="${bytes_of[${sha}]}"
      fetched_file="${fetch_dir}/${sha:0:2}/${sha}"
      [[ -f "${fetched_file}" && ! -L "${fetched_file}" ]] ||
        die "object ${sha} is missing from the object store; release ${release} cannot be loaded"
      file_matches "${fetched_file}" "${sha}" "${bytes}" ||
        die "object ${sha} failed verification against the manifest of release ${release}"
      chmod 0444 -- "${fetched_file}"
      object_cache_dir "${sha}"
      mv -f -- "${fetched_file}" "$(object_cache_path "${sha}")"
      fetched=$((fetched + 1))
    done
    rm -rf -- "${fetch_dir}"
    fetch_dir=""
  fi

  while IFS=$'\t' read -r relative sha bytes; do
    target="${payload_dir}/${relative}"
    object="$(object_cache_path "${sha}")"
    mkdir -p -- "$(dirname -- "${target}")"
    [[ ! -L "${target}" ]] || die "unsafe cached path: ${target}"
    if [[ "${relative}" == mods/* ]]; then
      if [[ -f "${target}" && "${target}" -ef "${object}" ]]; then
        kept=$((kept + 1))
        continue
      fi
      tmp="$(mktemp -u "$(dirname -- "${target}")/.reuse.XXXXXX")"
      # The payload directory is never mounted into the container, so it may share the inode.
      object_cache_link_or_copy "${object}" "${tmp}" "${sha}" "${bytes}" link
    else
      if [[ -f "${target}" ]] && file_matches "${target}" "${sha}" "${bytes}"; then
        kept=$((kept + 1))
        continue
      fi
      tmp="$(mktemp -u "$(dirname -- "${target}")/.reuse.XXXXXX")"
      cp -- "${object}" "${tmp}"
      chmod 0644 -- "${tmp}"
      file_matches "${tmp}" "${sha}" "${bytes}" || die "copy of override ${relative} failed verification"
    fi
    mv -f -- "${tmp}" "${target}"
    downloaded=$((downloaded + 1))
  done < <(jq -r '
    (.server.mods[] | ["mods/" + .file, .sha256, (.bytes | tostring)]),
    ((.server.overrides // [])[] | ["overrides/" + .path, .sha256, (.bytes | tostring)])
    | @tsv
    ' "${manifest_tmp}")
}

if [[ "${layout}" == "objects-v1" ]]; then
  download_objects_v1
  mv -- "${manifest_tmp}" "${payload_dir}/manifest.json"
  trap - EXIT
  printf 'result=release_ready\n'
  printf 'game=%s\n' "${game}"
  printf 'preset=%s\n' "${preset_id}"
  printf 'release=%s\n' "${release}"
  printf 'payload=%s\n' "${payload_dir}"
  printf 'downloaded=%s\n' "${downloaded}"
  printf 'kept=%s\n' "${kept}"
  printf 'reused=0\n'
  printf 'layout=objects-v1\n'
  printf 'fetched=%s\n' "${fetched}"
  # Measurement hook: wall time of this download, for docs/measurements.md.
  printf 'seconds=%s\n' "${SECONDS}"
  exit 0
fi

# Other cached releases of this game often hold the same bytes. Their manifests
# name each file by hash, so a match is linked in, never fetched again. Only the
# standard cache layout <game>/<preset>/<release> is searched.
declare -A reuse_by_sha=()
game_root="$(dirname -- "$(dirname -- "${payload_dir}")")"
if [[ "$(basename -- "${payload_dir}")" == "${release}" &&
  "$(basename -- "$(dirname -- "${payload_dir}")")" == "${preset_id}" &&
  "$(basename -- "${game_root}")" == "${game}" ]]; then
  for sibling_manifest in "${game_root}"/*/*/manifest.json; do
    [[ -f "${sibling_manifest}" && ! -L "${sibling_manifest}" ]] || continue
    sibling_dir="$(realpath -e -- "$(dirname -- "${sibling_manifest}")")" || continue
    [[ "${sibling_dir}" != "${payload_dir}" ]] || continue
    while IFS=$'\t' read -r sha relative; do
      [[ -n "${reuse_by_sha[${sha}]:-}" ]] || reuse_by_sha["${sha}"]="${sibling_dir}/${relative}"
    done < <(jq -r '
      (.server.mods // [])[] | select((.file | type == "string") and (.sha256 | type == "string")) |
      [.sha256, "mods/" + .file] | @tsv
      ' "${sibling_manifest}" 2>/dev/null || true)
    while IFS=$'\t' read -r sha relative; do
      [[ -n "${reuse_by_sha[${sha}]:-}" ]] || reuse_by_sha["${sha}"]="${sibling_dir}/${relative}"
    done < <(jq -r '
      (.server.overrides // [])[] | select((.path | type == "string") and (.sha256 | type == "string")) |
      [.sha256, "overrides/" + .path] | @tsv
      ' "${sibling_manifest}" 2>/dev/null || true)
  done
fi

# A candidate counts only when no symbolic link sits anywhere on its path.
reuse_cached() {
  local relative="$1" expected_sha="$2" expected_bytes="$3" target="$4" candidate resolved link_tmp
  candidate="${reuse_by_sha[${expected_sha}]:-}"
  [[ -n "${candidate}" ]] || return 1
  resolved="$(realpath -e -- "${candidate}" 2>/dev/null)" || return 1
  [[ "${resolved}" == "${candidate}" ]] || return 1
  file_matches "${resolved}" "${expected_sha}" "${expected_bytes}" || return 1
  link_tmp="$(mktemp -u "$(dirname -- "${target}")/.reuse.XXXXXX")"
  ln -- "${resolved}" "${link_tmp}" 2>/dev/null ||
    cp --reflink=auto -- "${resolved}" "${link_tmp}" || return 1
  if ! file_matches "${link_tmp}" "${expected_sha}" "${expected_bytes}"; then
    rm -f -- "${link_tmp}"
    return 1
  fi
  mv -- "${link_tmp}" "${target}" || {
    rm -f -- "${link_tmp}"
    return 1
  }
  log "reused ${relative} from another cached release"
}

downloaded=0
kept=0
reused=0
missing=()
while IFS=$'\t' read -r relative expected_sha expected_bytes; do
  target="${payload_dir}/${relative}"
  mkdir -p -- "$(dirname -- "${target}")"
  if [[ -f "${target}" && ! -L "${target}" ]]; then
    if file_matches "${target}" "${expected_sha}" "${expected_bytes}"; then
      kept=$((kept + 1))
      continue
    fi
    log "cached ${relative} does not match the manifest; refetching"
    rm -f -- "${target}"
  fi
  [[ ! -e "${target}" && ! -L "${target}" ]] || die "unsafe cached path: ${target}"
  if reuse_cached "${relative}" "${expected_sha}" "${expected_bytes}" "${target}"; then
    reused=$((reused + 1))
    continue
  fi
  missing+=("${relative}"$'\t'"${expected_sha}"$'\t'"${expected_bytes}")
done < <(jq -r '
  (.server.mods[] | ["mods/" + .file, .sha256, (.bytes | tostring)]),
  ((.server.overrides // [])[] | ["overrides/" + .path, .sha256, (.bytes | tostring)])
  | @tsv
  ' "${manifest_tmp}")

# One concurrent copy of the missing mods/ and overrides/ keys. The client.zip,
# server.zip and full.zip packs sit beside them and are never included.
if ((${#missing[@]} > 0)); then
  fetch_dir="$(mktemp -d "${payload_dir}/.fetch.XXXXXX")"
  filters=(--exclude '*')
  for entry in "${missing[@]}"; do
    filters+=(--include "$(glob_literal "${entry%%$'\t'*}")")
  done
  aws "${S3_GLOBAL_ARGS[@]}" s3 cp \
    "s3://${RELEASE_BUCKET}/${release_prefix}/" "${fetch_dir}/" \
    --recursive --only-show-errors "${filters[@]}" >&2 ||
    die "could not download the files of release ${release}"

  # The copy does not compare hashes, so every file is held to the manifest.
  for entry in "${missing[@]}"; do
    IFS=$'\t' read -r relative expected_sha expected_bytes <<<"${entry}"
    fetched="${fetch_dir}/${relative}"
    [[ -f "${fetched}" && ! -L "${fetched}" ]] || die "could not download ${relative} for release ${release}"
    file_matches "${fetched}" "${expected_sha}" "${expected_bytes}" ||
      die "downloaded ${relative} failed verification against the manifest"
    mv -- "${fetched}" "${payload_dir}/${relative}"
    downloaded=$((downloaded + 1))
  done
  rm -rf -- "${fetch_dir}"
  fetch_dir=""
fi

mv -- "${manifest_tmp}" "${payload_dir}/manifest.json"
trap - EXIT

printf 'result=release_ready\n'
printf 'game=%s\n' "${game}"
printf 'preset=%s\n' "${preset_id}"
printf 'release=%s\n' "${release}"
printf 'payload=%s\n' "${payload_dir}"
printf 'downloaded=%s\n' "${downloaded}"
printf 'kept=%s\n' "${kept}"
printf 'reused=%s\n' "${reused}"
printf 'layout=legacy\n'
printf 'seconds=%s\n' "${SECONDS}"
