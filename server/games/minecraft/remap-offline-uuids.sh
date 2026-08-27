#!/usr/bin/env bash

# Adoption helper (docs/runbook.md): a world that lived under online-mode=true
# — or a signed-in single-player save — keys player files by the Mojang
# account UUID, while online-mode=false (ADR-0022) derives the UUID from the
# name. Rename one player's files so the same person keeps their inventory,
# position and progress. The name is case-sensitive: the derived UUID changes
# with it.

set -Eeuo pipefail

usage() {
  cat >&2 <<'EOF'
usage: remap-offline-uuids.sh <world-dir> <player-name> [source-uuid]

  world-dir    the world folder holding playerdata/, advancements/, stats/
  player-name  the exact in-game name, case-sensitive
  source-uuid  the player's current UUID; may be omitted when playerdata/
               holds exactly one candidate
EOF
}

[[ $# -eq 2 || $# -eq 3 ]] || {
  usage
  exit 2
}

world_dir="$1"
player_name="$2"
source_uuid="${3:-}"
uuid_re='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'

command -v python3 >/dev/null 2>&1 || {
  printf 'error: required command not found: python3\n' >&2
  exit 1
}
[[ -d "${world_dir}" ]] || {
  printf 'error: world directory does not exist: %s\n' "${world_dir}" >&2
  exit 1
}
[[ "${player_name}" =~ ^[A-Za-z0-9_]{1,16}$ ]] || {
  printf 'error: invalid player name: %s\n' "${player_name}" >&2
  exit 1
}

target_uuid="$(python3 - "${player_name}" <<'PY'
import hashlib, sys, uuid
# Java's UUID.nameUUIDFromBytes: md5 of the raw bytes, version 3, RFC variant.
digest = bytearray(hashlib.md5(b"OfflinePlayer:" + sys.argv[1].encode("utf-8")).digest())
digest[6] = (digest[6] & 0x0F) | 0x30
digest[8] = (digest[8] & 0x3F) | 0x80
print(uuid.UUID(bytes=bytes(digest)))
PY
)"

already_offline() {
  printf 'result=already_offline\n'
  printf 'player=%s\n' "${player_name}"
  printf 'target_uuid=%s\n' "${target_uuid}"
  exit 0
}

if [[ -n "${source_uuid}" ]]; then
  source_uuid="$(tr '[:upper:]' '[:lower:]' <<<"${source_uuid}")"
  [[ "${source_uuid}" =~ ${uuid_re} ]] || {
    printf 'error: invalid source UUID: %s\n' "${source_uuid}" >&2
    exit 1
  }
else
  candidates=()
  if [[ -d "${world_dir}/playerdata" ]]; then
    while IFS= read -r -d '' dat; do
      candidate="$(basename -- "${dat}" .dat)"
      [[ "${candidate}" =~ ${uuid_re} ]] || continue
      [[ "${candidate}" != "${target_uuid}" ]] || continue
      candidates+=("${candidate}")
    done < <(find "${world_dir}/playerdata" -maxdepth 1 -type f -name '*.dat' -print0 | sort -z)
  fi
  if (( ${#candidates[@]} == 0 )); then
    [[ ! -f "${world_dir}/playerdata/${target_uuid}.dat" ]] || already_offline
    printf 'error: no player files found under %s/playerdata\n' "${world_dir}" >&2
    exit 1
  fi
  (( ${#candidates[@]} == 1 )) || {
    printf 'error: several candidate UUIDs; pass the source explicitly:\n' >&2
    printf '  %s\n' "${candidates[@]}" >&2
    exit 1
  }
  source_uuid="${candidates[0]}"
fi

[[ "${source_uuid}" != "${target_uuid}" ]] || already_offline

# Two passes — verify every destination first, then move — so a collision
# refuses before anything changed rather than mid-way.
relative_paths=(
  "playerdata/${source_uuid}.dat"
  "playerdata/${source_uuid}.dat_old"
  "advancements/${source_uuid}.json"
  "stats/${source_uuid}.json"
)
to_move=()
for relative in "${relative_paths[@]}"; do
  [[ -f "${world_dir}/${relative}" ]] || continue
  destination="${world_dir}/${relative//${source_uuid}/${target_uuid}}"
  [[ ! -e "${destination}" ]] || {
    printf 'error: refusing to overwrite %s\n' "${destination}" >&2
    exit 1
  }
  to_move+=("${relative}")
done

(( ${#to_move[@]} > 0 )) || {
  printf 'error: no files for UUID %s under %s\n' "${source_uuid}" "${world_dir}" >&2
  exit 1
}

for relative in "${to_move[@]}"; do
  mv -- "${world_dir}/${relative}" "${world_dir}/${relative//${source_uuid}/${target_uuid}}"
done

printf 'result=remapped\n'
printf 'player=%s\n' "${player_name}"
printf 'source_uuid=%s\n' "${source_uuid}"
printf 'target_uuid=%s\n' "${target_uuid}"
printf 'moved=%s\n' "${#to_move[@]}"
