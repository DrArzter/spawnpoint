#!/usr/bin/env bash

# Prove that an existing live mods directory is exactly one immutable release.
# This is read-only: unlike reconcile-release.sh it never replaces or removes a
# file. Adoption uses the proof before it creates the world's first pointer.

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source-path=SCRIPTDIR
# shellcheck source=_common.sh
source "${SCRIPT_DIR}/_common.sh"

usage() {
  printf 'usage: verify-installed-release.sh <manifest.json> [installed-mod-directory]\n' >&2
  exit 2
}

[[ $# -ge 1 && $# -le 2 ]] || usage

require_command find
require_command jq
require_command sha256sum
require_command stat

manifest="$(realpath -e -- "$1")"
mods_dir="$(realpath -e -- "${2:-${SERVER_MODS_DIR:-${SERVER_DIR}/mods}}")"

[[ -f "${manifest}" && ! -L "${manifest}" ]] || die "manifest must be a regular non-symlink file: ${manifest}"
[[ -d "${mods_dir}" && ! -L "${mods_dir}" ]] || die "installed mod directory must be a non-symlink directory: ${mods_dir}"

jq -e '
  .schema_version == 1 and
  (.release | type == "string" and test("^[0-9]+\\.[0-9]+$")) and
  (.minecraft_version | type == "string" and length > 0) and
  (.loader.type == "forge") and
  (.loader.version | type == "string" and length > 0) and
  (.server.mods | type == "array") and
  all(.server.mods[];
    (.file | type == "string" and test("^[^/\\\\]+\\.jar$")) and
    (.sha256 | type == "string" and test("^[0-9a-f]{64}$")) and
    (.bytes | type == "number" and floor == . and . >= 0)
  ) and
  (([.server.mods[].file] | unique | length) == (.server.mods | length))
' "${manifest}" >/dev/null || die "invalid release manifest: ${manifest}"

release="$(jq -r '.release' "${manifest}")"
expected_count="$(jq -r '.server.mods | length' "${manifest}")"
verified_bytes=0

while IFS=$'\t' read -r filename expected_sha expected_bytes; do
  installed_file="${mods_dir}/${filename}"
  [[ -f "${installed_file}" && ! -L "${installed_file}" ]] || die "installed release is missing a regular JAR: ${filename}"

  actual_bytes="$(stat --format '%s' -- "${installed_file}")"
  [[ "${actual_bytes}" == "${expected_bytes}" ]] ||
    die "installed size mismatch for ${filename}: expected ${expected_bytes}, got ${actual_bytes}"

  actual_sha="$(sha256sum -- "${installed_file}")"
  actual_sha="${actual_sha%% *}"
  [[ "${actual_sha}" == "${expected_sha}" ]] || die "installed SHA-256 mismatch for ${filename}"
  verified_bytes=$((verified_bytes + actual_bytes))
done < <(jq -r '.server.mods[] | [.file, .sha256, (.bytes | tostring)] | @tsv' "${manifest}")

actual_count="$(find "${mods_dir}" -maxdepth 1 -type f \( -name '*.jar' -o -name '*.zip' \) -printf '.' | wc -c)"
[[ "${actual_count}" == "${expected_count}" ]] ||
  die "installed JAR count mismatch: expected ${expected_count}, got ${actual_count}"

printf 'result=verified\n'
printf 'release=%s\n' "${release}"
printf 'mods=%s\n' "${expected_count}"
printf 'bytes=%s\n' "${verified_bytes}"
printf 'directory=%s\n' "${mods_dir}"
