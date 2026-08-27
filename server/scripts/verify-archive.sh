#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_common.sh
source "${SCRIPT_DIR}/_common.sh"

archive="${1:-}"
world_name="${WORLD_NAME:-world}"

# The archive sentinel is per game: level.dat for minecraft, a saves/*.zip
# for factorio. Same default rule as everywhere — no game named means
# minecraft, byte-identical to the pre-adapter behaviour.
# shellcheck source=../games/_dispatch.sh
source "$(cd -- "${SCRIPT_DIR}/.." && pwd)/games/_dispatch.sh"
resolve_game
sentinel_regex="$(game_archive_sentinel_regex "${world_name}")"

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

has_sentinel=false
for entry in "${entries[@]}"; do
  if [[ "${entry}" == /* ]] || [[ "/${entry}/" == *"/../"* ]]; then
    die "unsafe path in archive: ${entry}"
  fi
  if [[ "${entry}" =~ ${sentinel_regex} ]]; then
    has_sentinel=true
  fi
done

[[ "${has_sentinel}" == "true" ]] || die "archive does not contain a recognisable ${GAME_ID} save (${sentinel_regex})"

# Reading every compressed member catches truncation that a listing alone might miss.
tar --extract --zstd --to-stdout --file "${archive}" >/dev/null

printf 'result=verified\n'
printf 'archive=%s\n' "${archive}"
printf 'archive_bytes=%s\n' "$(stat --format '%s' -- "${archive}")"
printf 'entry_count=%s\n' "${#entries[@]}"
