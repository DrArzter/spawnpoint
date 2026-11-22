#!/usr/bin/env bash

# Host object cache for content-addressed releases (storage layout objects-v1).
# One file per digest, shared by every release, preset and game on the host:
#   ${OBJECT_CACHE_DIR:-${SERVER_DIR}/objects}/sha256/<first 2 hex>/<64 hex>
# A file is owned by root with mode 0444. It enters the cache only after a
# verified fetch (size and SHA-256) and a rename on the same filesystem.
# Needs _common.sh (SERVER_DIR, die, log).
# shellcheck shell=bash

object_cache_root() {
  printf '%s' "${OBJECT_CACHE_DIR:-${SERVER_DIR}/objects}"
}

object_cache_path() {
  local digest="$1"
  printf '%s/sha256/%s/%s' "$(object_cache_root)" "${digest:0:2}" "${digest}"
}

# Create the cache root and refuse a symbolic link anywhere on its path.
object_cache_init() {
  local root
  root="$(object_cache_root)"
  [[ "$(realpath -m -- "${root}")" == "$(realpath -m -s -- "${root}")" ]] ||
    die "the object cache path contains a symbolic link: ${root}"
  mkdir -p -- "${root}/sha256"
  chmod 0755 -- "${root}" "${root}/sha256"
}

# Directory of one digest, created 0755. A link in its place is refused.
object_cache_dir() {
  local digest="$1" root dir
  root="$(object_cache_root)"
  dir="${root}/sha256/${digest:0:2}"
  [[ ! -L "${root}" && ! -L "${root}/sha256" && ! -L "${dir}" ]] ||
    die "the object cache path contains a symbolic link: ${dir}"
  mkdir -p -- "${dir}"
  chmod 0755 -- "${dir}"
}

# A file is trusted without a hash only when it has the exact size and the
# cache's own owner and mode: root, 0444.
object_cache_trusted() {
  local file="$1" bytes="$2"
  [[ -f "${file}" && ! -L "${file}" ]] || return 1
  [[ "$(stat --format '%s %u %a' -- "${file}")" == "${bytes} 0 444" ]]
}

# OBJECT_CACHE_STAGE_MODE decides how a mod reaches the staged mods directory,
# which is bind-mounted into the game container:
#   copy (default)  a copy, checked against the digest. Whatever the container
#                   does to the mount cannot reach the shared cache object.
#   link            a hard link, sharing the cache inode. Allowed only after
#                   server/tests/object-cache-mount-test.sh (mode link) passes
#                   on a real host with the pinned game image. On the stand-in
#                   image the image's start-up chown made the cache object
#                   writable by the game user, so link is NOT the default.
# A copy is also the fallback when a link is impossible (another filesystem).
# A fifth argument overrides the mode. OBJECT_LINKED tells the caller which one happened.
# shellcheck disable=SC2034 # read by the callers
object_cache_link_or_copy() {
  local object="$1" target="$2" sha="$3" bytes="$4" actual mode="${5:-${OBJECT_CACHE_STAGE_MODE:-copy}}"
  [[ "${mode}" == "copy" || "${mode}" == "link" ]] || die "OBJECT_CACHE_STAGE_MODE must be copy or link, not '${mode}'"
  OBJECT_LINKED=true
  [[ "${mode}" == "link" ]] && ln -- "${object}" "${target}" 2>/dev/null && return 0
  OBJECT_LINKED=false
  cp --reflink=auto -- "${object}" "${target}" || die "could not copy object ${sha} to ${target}"
  chmod 0644 -- "${target}"
  actual="$(sha256sum -- "${target}")"
  if [[ "$(stat --format '%s' -- "${target}")" != "${bytes}" || "${actual%% *}" != "${sha}" ]]; then
    rm -f -- "${target}"
    die "copy of object ${sha} failed verification"
  fi
}
