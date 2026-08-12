#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_common.sh
source "${SCRIPT_DIR}/_common.sh"

archive="${1:-}"
world_name="${WORLD_NAME:-world}"

[[ -n "${archive}" ]] || die "usage: verify-archive.sh <archive.tar.zst>"
archive="$(realpath -m -- "${archive}")"
[[ -f "${archive}" ]] || die "archive does not exist: ${archive}"
[[ -s "${archive}" ]] || die "archive is empty: ${archive}"
[[ -f "${archive}.sha256" ]] || die "checksum does not exist: ${archive}.sha256"

(
  cd -- "$(dirname -- "${archive}")"
  sha256sum --check --status "$(basename -- "${archive}.sha256")"
) || die "checksum verification failed: ${archive}"

mapfile -t entries < <(tar --list --zstd --file "${archive}")
(( ${#entries[@]} > 0 )) || die "archive contains no entries"

has_level_dat=false
for entry in "${entries[@]}"; do
  if [[ "${entry}" == /* ]] || [[ "/${entry}/" == *"/../"* ]]; then
    die "unsafe path in archive: ${entry}"
  fi
  if [[ "${entry}" == "${world_name}/level.dat" ]]; then
    has_level_dat=true
  fi
done

[[ "${has_level_dat}" == "true" ]] || die "archive does not contain ${world_name}/level.dat"

# Reading every compressed member catches truncation that a listing alone might miss.
tar --extract --zstd --to-stdout --file "${archive}" >/dev/null

printf 'result=verified\n'
printf 'archive=%s\n' "${archive}"
printf 'archive_bytes=%s\n' "$(stat --format '%s' -- "${archive}")"
printf 'entry_count=%s\n' "${#entries[@]}"
