#!/usr/bin/env bash

set -Eeuo pipefail

REPOSITORY_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPTS="${REPOSITORY_ROOT}/server/scripts"
fixture="$(mktemp -d /tmp/spawnpoint-installed-release-test.XXXXXXXX)"
trap 'rm -rf -- "${fixture}"' EXIT

expect_failure() {
  local label="$1"
  shift
  if "$@" >/dev/null 2>&1; then
    printf 'expected failure: %s\n' "${label}" >&2
    exit 1
  fi
}

mkdir -p -- "${fixture}/release/mods" "${fixture}/server/mods"
printf 'alpha payload\n' >"${fixture}/release/mods/alpha.jar"
printf 'bracket payload\n' >"${fixture}/release/mods/dungeon[Forge].jar"

manifest="${fixture}/release/manifest.json"
"${SCRIPTS}/build-release-manifest.sh" \
  1.0 1.20.1 47.4.10 "${fixture}/release/mods" "${manifest}" >/dev/null
cp -- "${fixture}/release/mods/"*.jar "${fixture}/server/mods/"

output="$("${SCRIPTS}/verify-installed-release.sh" "${manifest}" "${fixture}/server/mods")"
grep -qx 'result=verified' <<<"${output}"
grep -qx 'release=1.0' <<<"${output}"
grep -qx 'mods=2' <<<"${output}"

printf 'tampered\n' >>"${fixture}/server/mods/alpha.jar"
expect_failure "changed JAR bytes" \
  "${SCRIPTS}/verify-installed-release.sh" "${manifest}" "${fixture}/server/mods"
cp -- "${fixture}/release/mods/alpha.jar" "${fixture}/server/mods/alpha.jar"

printf 'extra\n' >"${fixture}/server/mods/extra.jar"
expect_failure "extra JAR" \
  "${SCRIPTS}/verify-installed-release.sh" "${manifest}" "${fixture}/server/mods"
rm -- "${fixture}/server/mods/extra.jar"

rm -- "${fixture}/server/mods/alpha.jar"
expect_failure "missing JAR" \
  "${SCRIPTS}/verify-installed-release.sh" "${manifest}" "${fixture}/server/mods"
cp -- "${fixture}/release/mods/alpha.jar" "${fixture}/server/mods/alpha.jar"

rm -- "${fixture}/server/mods/alpha.jar"
ln -s -- "${fixture}/release/mods/alpha.jar" "${fixture}/server/mods/alpha.jar"
expect_failure "symlinked JAR" \
  "${SCRIPTS}/verify-installed-release.sh" "${manifest}" "${fixture}/server/mods"

printf 'installed-release-test: ok\n'
