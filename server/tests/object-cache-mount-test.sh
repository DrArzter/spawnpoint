#!/usr/bin/env bash

# Does a container leave a hard-linked cache object alone?
#
# A staged mod (objects-v1) is by default a copy of the host object cache file;
# with OBJECT_CACHE_STAGE_MODE=link it is a hard link. The staged mods directory
# is bind-mounted at /data/mods. A hard link shares the inode, so whatever the container does to the mounted file it does to the
# cache object for every release on the host. This test builds that situation
# (a root-owned 0444 object linked into a mods directory), runs in a container
# what the itzg image does to /data at start-up (recursive chown and chmod) and
# what a game or a mod might do (write and overwrite, as root and as a normal
# user), and asserts on the host that the object's inode, owner, group, mode,
# size and SHA-256 are unchanged. The files are made and read by a root helper
# container, so the test also runs from a non-root account; on Linux the host's
# own stat is compared as well. Where the host is not Linux (Docker Desktop
# squashes owners and modes on a bind mount, so the result would say nothing),
# the same directories live in a named volume and are mounted by subpath, which
# keeps real Linux file semantics.
#
# Needs a docker daemon, so it runs on the host (scripts/check.sh), not in the
# alpine shard loop.
#
# A pass with the stand-in image (alpine) is NOT proof for the real itzg image.
# Before OBJECT_CACHE_STAGE_MODE=link or OBJECT_CACHE_START_CHECK=size is turned
# on, the owner must run this with OBJECT_MOUNT_TEST_MODE=link on a host with
# OBJECT_MOUNT_TEST_IMAGE set to the pinned game image (the digest in
# server/compose.yaml). Until then the copy and the hash check stay the default
# (reconcile-release.sh).
#
# Environment:
#   OBJECT_MOUNT_TEST_IMAGE     image to run, default alpine:3.20
#   OBJECT_MOUNT_TEST_REQUIRED  true: a missing docker is a failure, not a SKIP

set -Eeuo pipefail

image="${OBJECT_MOUNT_TEST_IMAGE:-alpine:3.20}"
# copy: the staged mod is a copy (the default of reconcile-release.sh); the cache
# object must survive whatever the container does. link: the staged mod is a
# hard link (OBJECT_CACHE_STAGE_MODE=link). With the stand-in image this mode
# FAILS: the image's start-up chown makes the shared object writable by the game
# user. Run it against the pinned game image before anyone sets link.
mode="${OBJECT_MOUNT_TEST_MODE:-copy}"
[[ "${mode}" == "copy" || "${mode}" == "link" ]] || { printf 'OBJECT_MOUNT_TEST_MODE must be copy or link\n' >&2; exit 2; }

if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  if [[ "${OBJECT_MOUNT_TEST_REQUIRED:-false}" == "true" ]]; then
    printf 'FAIL: docker is not available and OBJECT_MOUNT_TEST_REQUIRED=true\n' >&2
    exit 1
  fi
  printf 'SKIP: docker is not available; the object cache mount test did not run\n'
  exit 0
fi

# Both layouts give /work (cache, mods, probe) to the root helper and mount only
# mods at /data/mods and probe at /probe in a step.
if [[ "$(uname -s)" == "Linux" ]]; then
  work="$(mktemp -d "${TMPDIR:-/tmp}/spawnpoint-object-mount-test.XXXXXXXX")"
  volume=""
  work_mount=(-v "${work}:/work")
  step_mounts=(-v "${work}/mods:/data/mods" -v "${work}/probe:/probe:ro")
else
  work=""
  volume="spawnpoint-object-mount-test-$$"
  docker volume create "${volume}" >/dev/null
  work_mount=(-v "${volume}:/work")
  step_mounts=(
    --mount "type=volume,src=${volume},dst=/data/mods,volume-subpath=mods"
    --mount "type=volume,src=${volume},dst=/probe,volume-subpath=probe,readonly"
  )
fi
helper() { # a root container on the work directory
  docker run --rm --pull=missing "${work_mount[@]}" "${image}" sh -c "$1"
}
cleanup() {
  if [[ -n "${volume}" ]]; then
    docker volume rm -f "${volume}" >/dev/null 2>&1 || true
  else
    helper 'rm -rf /work/cache /work/mods /work/probe' >/dev/null 2>&1 || true
    rm -rf -- "${work}"
  fi
}
trap cleanup EXIT

# One object: its digest is its name, as in the cache.
helper '
  set -e
  mkdir -p /work/cache/sha256/ab /work/mods /work/probe
  printf "object bytes of a mod\n" >/work/cache/sha256/ab/object
  chown 0:0 /work/cache/sha256/ab/object
  chmod 0444 /work/cache/sha256/ab/object
  if [ "'"${mode}"'" = link ]; then ln /work/cache/sha256/ab/object /work/mods/alpha.jar
  else cp /work/cache/sha256/ab/object /work/mods/alpha.jar; fi
  printf "not a mod\n" >/work/probe/new-bytes
  chmod 0755 /work/probe
  chmod 0644 /work/probe/new-bytes
  chmod 0755 /work/mods
'

snapshot() {
  helper '
    cd /work/cache/sha256/ab
    stat -c "inode=%i owner=%u group=%g mode=%a size=%s links=%h" object
    sha256sum object | cut -d" " -f1
  '
}
# The host's own view, where its stat is GNU stat.
host_snapshot() {
  if [[ -n "${work}" ]] && stat --format '%i' / >/dev/null 2>&1; then
    stat --format 'inode=%i owner=%u group=%g mode=%a size=%s links=%h' -- "${work}/cache/sha256/ab/object"
  fi
}

before="$(snapshot)"
host_before="$(host_snapshot)"
printf 'before: %s\n' "${before//$'\n'/ sha256=}"

# Each step runs in its own container with only the mods directory mounted, as
# the compose file mounts it. The object must be identical after every step.
step() {
  local label="$1" user="$2" script="$3" after host_after
  docker run --rm --user "${user}" "${step_mounts[@]}" \
    "${image}" sh -c "${script}" >/dev/null 2>&1 || true # a refused write is the good outcome
  after="$(snapshot)"
  host_after="$(host_snapshot)"
  if [[ "${after}" != "${before}" || "${host_after}" != "${host_before}" ]]; then
    printf 'FAIL: the cache object changed after: %s\n  before: %s\n  after:  %s\n' \
      "${label}" "${before//$'\n'/ sha256=}" "${after//$'\n'/ sha256=}" >&2
    exit 1
  fi
  printf 'unchanged after: %s\n' "${label}"
}

write_probe='
  echo appended >>/data/mods/alpha.jar
  cat /probe/new-bytes >/data/mods/alpha.jar
  cp -f /probe/new-bytes /data/mods/alpha.jar
  chmod 0666 /data/mods/alpha.jar
'
# What the image start-up does to the data directory.
startup='
  mkdir -p /data
  chown -R 1000:1000 /data
  chmod -R u+rwX,go+rX /data
'

step "write and overwrite attempts as a normal user" 1000:1000 "${write_probe}"
step "image start-up: recursive chown and chmod of /data, as root" 0:0 "${startup}"
step "write and overwrite attempts as a normal user, after the start-up pass" 1000:1000 "${write_probe}"
step "write and overwrite attempts as root" 0:0 "${write_probe}"

printf 'object cache mount test passed with image %s\n' "${image}"
if [[ "${image}" == alpine:* ]]; then
  printf 'note: the stand-in image is not proof for the pinned game image; see the file header\n'
fi
