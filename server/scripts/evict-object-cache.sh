#!/usr/bin/env bash

# Free disk by evicting objects from the host object cache (objects-v1).
# Runs only when free space on the cache filesystem is below
# OBJECT_CACHE_MIN_FREE_GB (default 20). Then it removes files, oldest mtime
# first, until the space is back above the limit. It never removes:
#   - a file named by the manifest of a --keep release,
#   - a file with a hard-link count above 1 (a payload or mods directory uses it).
# An unreadable --keep manifest means nothing is evicted and the exit is non-zero.
#
# Test hooks: OBJECT_CACHE_FREE_KB_OVERRIDE replaces the df reading. Each
# removal then adds its size to that figure, so the loop ends as it would on a
# real disk. OBJECT_CACHE_EVICT_DRY_RUN=true removes nothing.

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_common.sh
source "${SCRIPT_DIR}/_common.sh"
# shellcheck source=_object-cache.sh
source "${SCRIPT_DIR}/_object-cache.sh"

usage() {
  die "usage: evict-object-cache.sh [--keep <game>/<preset>/<release>]..."
}

require_command jq
require_command flock

keeps=()
while (($# > 0)); do
  case "$1" in
    --keep)
      (($# >= 2)) || usage
      [[ "$2" =~ ^[a-z0-9][a-z0-9-]{0,31}/[a-z0-9][a-z0-9-]{0,31}/[0-9]+\.[0-9]+$ ]] || die "invalid --keep release: $2"
      keeps+=("$2")
      shift 2
      ;;
    *) usage ;;
  esac
done

min_free_gb="${OBJECT_CACHE_MIN_FREE_GB:-20}"
[[ "${min_free_gb}" =~ ^[0-9]+$ ]] || die "OBJECT_CACHE_MIN_FREE_GB must be a whole number"
dry_run="${OBJECT_CACHE_EVICT_DRY_RUN:-false}"
min_free_kb=$((min_free_gb * 1024 * 1024))

cache_root="$(object_cache_root)"

# Every keep manifest is read before anything else, so a failure evicts nothing.
declare -A keep_digest=()
for keep in "${keeps[@]}"; do
  keep_manifest="${SERVER_DIR}/releases/${keep}/manifest.json"
  [[ -f "${keep_manifest}" && ! -L "${keep_manifest}" ]] || die "manifest of kept release ${keep} is not readable; nothing is evicted"
  digests="$(jq -r '(.server.mods[], (.server.overrides // [])[]) | .sha256 | select(type == "string")' "${keep_manifest}")" ||
    die "manifest of kept release ${keep} is not valid; nothing is evicted"
  while read -r digest; do
    [[ -z "${digest}" ]] || keep_digest["${digest}"]=1
  done <<<"${digests}"
done

report() {
  printf 'result=%s\n' "$1"
  [[ "${dry_run}" != "true" ]] || printf 'dry_run=true\n'
  printf 'evicted=%s\n' "${evicted}"
  printf 'bytes=%s\n' "${evicted_bytes}"
  printf 'protected=%s\n' "${protected}"
  printf 'free_kb=%s\n' "${free_kb}"
}

evicted=0
evicted_bytes=0
protected=0
free_kb=0

if [[ ! -d "${cache_root}/sha256" ]]; then
  report nothing_to_evict
  exit 0
fi

if [[ -n "${OBJECT_CACHE_FREE_KB_OVERRIDE:-}" ]]; then
  free_kb="${OBJECT_CACHE_FREE_KB_OVERRIDE}"
else
  free_kb="$(df -Pk -- "${cache_root}" | awk 'NR == 2 { print $4 }')"
fi
[[ "${free_kb}" =~ ^[0-9]+$ ]] || die "could not read the free space of ${cache_root}"

if ((free_kb >= min_free_kb)); then
  report nothing_to_evict
  exit 0
fi

# Same lock as the download, so an object is not removed while a download
# decides to use it.
exec 8>"${cache_root}/.cache.lock"
flock -w "${DOWNLOAD_LOCK_WAIT_SECONDS:-900}" 8 || die "another process is changing the object cache"

while IFS=' ' read -r _ links bytes path; do
  ((free_kb < min_free_kb)) || break
  digest="${path##*/}"
  if ((links > 1)) || [[ -n "${keep_digest[${digest}]:-}" ]]; then
    protected=$((protected + 1))
    continue
  fi
  [[ "${dry_run}" == "true" ]] || rm -f -- "${path}"
  evicted=$((evicted + 1))
  evicted_bytes=$((evicted_bytes + bytes))
  free_kb=$((free_kb + (bytes + 1023) / 1024))
done < <(find "${cache_root}/sha256" -type f -regextype posix-extended -regex '.*/[0-9a-f]{2}/[0-9a-f]{64}' \
  -printf '%T@ %n %s %p\n' | sort -n)

if [[ "${dry_run}" != "true" ]]; then
  find "${cache_root}/sha256" -mindepth 1 -type d -empty -delete
fi

if ((evicted > 0)); then
  report evicted
else
  report nothing_to_evict
fi
