#!/usr/bin/env bash

# An uploaded pack is an archive somebody chose, so this covers the refusals
# before the happy path: traversal, symlinks, wrong contents, duplicate names
# and expansion past the caps. A refusal costs an upload; a release built from a
# poisoned archive costs the world.

set -Eeuo pipefail

REPOSITORY_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
EXTRACT="${REPOSITORY_ROOT}/server/scripts/extract-pack-upload.sh"
fixture="$(mktemp -d /tmp/spawnpoint-pack-upload-test.XXXXXXXX)"
cleanup() {
  rm -rf -- "${fixture}"
}
trap cleanup EXIT

expect_failure() {
  local label="$1"
  shift
  if "$@" >/dev/null 2>&1; then
    printf 'expected failure: %s\n' "${label}" >&2
    exit 1
  fi
}

pack() {
  local name="$1"
  shift
  local staging="${fixture}/build-${name}"
  rm -rf -- "${staging}"
  mkdir -p -- "${staging}"
  (cd "${staging}" && "$@" >/dev/null 2>&1)
  (cd "${staging}" && zip -q -r -y "${fixture}/${name}.zip" .)
  printf '%s' "${fixture}/${name}.zip"
}

# --- flat jars: the shape a player's mods folder has ---
flat="$(pack flat bash -c 'printf "alpha\n" >alpha-1.0.jar; printf "beta\n" >beta-2.0.jar')"
output="$("${EXTRACT}" "${flat}" "${fixture}/out-flat")"
grep -qx 'result=extracted' <<<"${output}"
grep -qx 'mods=2' <<<"${output}"
[[ -f "${fixture}/out-flat/alpha-1.0.jar" && -f "${fixture}/out-flat/beta-2.0.jar" ]]

# --- one mods/ directory: the shape a zipped folder has ---
nested="$(pack nested bash -c 'mkdir -p mods; printf "alpha\n" >mods/alpha-1.0.jar')"
nested_output="$("${EXTRACT}" "${nested}" "${fixture}/out-nested")"
grep -qx 'mods=1' <<<"${nested_output}"
[[ -f "${fixture}/out-nested/alpha-1.0.jar" ]]

# --- refusals ---
expect_failure "an existing output directory" "${EXTRACT}" "${flat}" "${fixture}/out-flat"

deep="$(pack deep bash -c 'mkdir -p mods/extra; printf "a\n" >mods/extra/alpha.jar')"
expect_failure "a nested directory below mods/" "${EXTRACT}" "${deep}" "${fixture}/out-deep"

mixed="$(pack mixed bash -c 'printf "a\n" >alpha.jar; printf "note\n" >README.txt')"
expect_failure "a pack carrying something that is not a mod" "${EXTRACT}" "${mixed}" "${fixture}/out-mixed"

empty="$(pack empty bash -c 'printf "note\n" >README.txt')"
expect_failure "a pack with no mods at all" "${EXTRACT}" "${empty}" "${fixture}/out-empty"

duplicate="$(pack duplicate bash -c 'mkdir -p mods; printf "a\n" >alpha.jar; printf "b\n" >mods/alpha.jar')"
expect_failure "the same file name twice" "${EXTRACT}" "${duplicate}" "${fixture}/out-duplicate"

# A symlink survives zip -y, which is exactly why the attributes are inspected.
linked="$(pack linked bash -c 'printf "a\n" >alpha.jar; ln -s /etc/passwd secrets.jar')"
expect_failure "a symbolic link in the pack" "${EXTRACT}" "${linked}" "${fixture}/out-linked"

# Traversal, written directly into the archive rather than through a filesystem.
mkdir -p -- "${fixture}/traversal"
printf 'a\n' >"${fixture}/traversal/alpha.jar"
(cd "${fixture}/traversal" && zip -q "${fixture}/traversal.zip" alpha.jar)
python3 - "${fixture}/traversal.zip" <<'PY'
import sys, zipfile
with zipfile.ZipFile(sys.argv[1], "a") as archive:
    archive.writestr("../escaped.jar", "owned")
PY
expect_failure "an entry escaping the directory" "${EXTRACT}" "${fixture}/traversal.zip" "${fixture}/out-traversal"
[[ ! -e "${fixture}/escaped.jar" ]]

# --- the caps, exercised with small limits rather than real ones ---
expect_failure "more entries than allowed" \
  env PACK_MAX_ENTRIES=1 "${EXTRACT}" "${flat}" "${fixture}/out-entries"
expect_failure "a single file over the entry cap" \
  env PACK_MAX_ENTRY_BYTES=1 "${EXTRACT}" "${flat}" "${fixture}/out-entry-bytes"
expect_failure "expansion over the total cap" \
  env PACK_MAX_TOTAL_BYTES=2 "${EXTRACT}" "${flat}" "${fixture}/out-total-bytes"

# A pack that only just fits is accepted: the caps must refuse, not merely warn.
fitting="$(PACK_MAX_ENTRIES=2 PACK_MAX_TOTAL_BYTES=64 "${EXTRACT}" "${flat}" "${fixture}/out-fitting")"
grep -qx 'mods=2' <<<"${fitting}"

printf 'pack-upload-test: ok\n'
