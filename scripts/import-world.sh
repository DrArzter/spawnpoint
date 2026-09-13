#!/usr/bin/env bash

# Import an existing world and its mod set into the system: build an immutable
# release manifest, publish the release, archive and upload the world, then
# write the world's release pointer (ADR-0030) — desired set, active null,
# because nothing has passed a health check yet.
#
# The pointer is written last and refused if present: importing is how a world
# ARRIVES; changing an existing world's release is a promotion, not an import.

set -Eeuo pipefail

REPOSITORY_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
SERVER_SCRIPTS="${REPOSITORY_ROOT}/server/scripts"

usage() {
  cat >&2 <<'EOF'
usage: import-world.sh <data-dir> <world-name> <mods-dir> <release> <game-version> <loader-version> [game]

  data-dir           directory that CONTAINS the save — the world folder(s) for
                     minecraft, saves/*.zip for factorio
  world-name         minecraft: the world folder's name inside data-dir;
                     other games: the world id the catalog will use
  mods-dir           the exact mod files this world runs on
  release            MAJOR.MINOR for the new immutable release, e.g. 1.0
  game-version       the game's own version; every game's manifest carries it
                     in the minecraft_version field (recorded wart, ADR-0034)
  game               defaults to minecraft (ADR-0034)

Environment:
  AWS_PROFILE        defaults to spawnpoint
  AWS_REGION         defaults to eu-central-1
  BACKUP_BUCKET      defaults to spawnpoint-backups-<account-id>
  RELEASE_BUCKET     defaults to spawnpoint-releases-<account-id>
  IMPORT_ACTOR       recorded in the manifest and pointer; defaults to import
  RELEASE_PROFILE_ID, RELEASE_PROFILE_REPOSITORY and RELEASE_PROFILE_COMMIT
                     required release provenance; use the imported world's preset and exact Git revision
  RELEASE_RUNTIME_IMAGE
                     required for games whose runtime is selected by the release; use a digest-addressed image
EOF
}

[[ $# -eq 6 || $# -eq 7 ]] || {
  usage
  exit 2
}

data_dir="$1"
world_name="$2"
mods_dir="$3"
release="$4"
minecraft_version="$5"
loader_version="$6"
game="${7:-minecraft}"

export AWS_PROFILE="${AWS_PROFILE:-spawnpoint}"
export AWS_REGION="${AWS_REGION:-eu-central-1}"
actor="${IMPORT_ACTOR:-import}"

for command in aws jq sha256sum; do
  command -v "${command}" >/dev/null 2>&1 || {
    printf 'error: required command not found: %s\n' "${command}" >&2
    exit 1
  }
done
for variable in RELEASE_PROFILE_ID RELEASE_PROFILE_REPOSITORY RELEASE_PROFILE_COMMIT; do
  [[ -n "${!variable:-}" ]] || {
    printf 'error: %s is required\n' "${variable}" >&2
    exit 1
  }
done

data_dir="$(realpath -e -- "${data_dir}")" || exit 1
mods_dir="$(realpath -e -- "${mods_dir}")" || exit 1
[[ "${world_name}" =~ ^[A-Za-z0-9._-]+$ ]] || {
  printf 'error: unsafe world name: %s\n' "${world_name}" >&2
  exit 1
}
[[ "${release}" =~ ^[0-9]+\.[0-9]+$ ]] || {
  printf 'error: release must use MAJOR.MINOR: %s\n' "${release}" >&2
  exit 1
}
# The game's own sentinel judges the save — level.dat for minecraft,
# saves/*.zip for factorio — and load_game refuses an unknown game before
# anything touches AWS (ADR-0034).
# shellcheck source=../server/games/_dispatch.sh
source "${REPOSITORY_ROOT}/server/games/_dispatch.sh"
load_game "${game}"
game_save_sentinel "${data_dir}" "${world_name}" || {
  printf 'error: %s does not hold a %s save (world %s)\n' "${data_dir}" "${game}" "${world_name}" >&2
  exit 1
}

if [[ -z "${BACKUP_BUCKET:-}" || -z "${RELEASE_BUCKET:-}" ]]; then
  account_id="$(aws sts get-caller-identity --query Account --output text)"
  [[ "${account_id}" =~ ^[0-9]{12}$ ]] || {
    printf 'error: could not resolve the AWS account id\n' >&2
    exit 1
  }
fi
export BACKUP_BUCKET="${BACKUP_BUCKET:-spawnpoint-backups-${account_id}}"
export RELEASE_BUCKET="${RELEASE_BUCKET:-spawnpoint-releases-${account_id}}"

pointer_key="worlds/${world_name}/release.json"

# Refuse early, before any upload: a pointer means this world already lives here.
if aws --region "${AWS_REGION}" --no-cli-pager s3api head-object \
  --bucket "${RELEASE_BUCKET}" \
  --key "${pointer_key}" \
  --query ContentLength \
  --output text >/dev/null 2>&1; then
  printf 'error: world %s is already imported (s3://%s/%s exists); changing its release is a promotion, not an import\n' \
    "${world_name}" "${RELEASE_BUCKET}" "${pointer_key}" >&2
  exit 1
fi

staging="$(mktemp -d /tmp/spawnpoint-import.XXXXXXXX)"
cleanup() {
  rm -rf -- "${staging}"
}
trap cleanup EXIT

# 1. Manifest from the exact mods this world runs on.
RELEASE_GAME="${game}" \
RELEASE_CREATED_BY="${actor}" \
RELEASE_CHANGELOG="Imported with world ${world_name}" \
  "${SERVER_SCRIPTS}/build-release-manifest.sh" \
  "${release}" "${minecraft_version}" "${loader_version}" "${mods_dir}" "${staging}/manifest.json" >"${staging}/manifest.out"

# 2. Publish the release. A byte-identical release already in the bucket is
#    fine — a second world importing the same pack is the multi-world case.
RELEASE_SOURCE_DIR="$(dirname -- "${mods_dir}")" \
  "${SERVER_SCRIPTS}/upload-release.sh" "${staging}/manifest.json" >"${staging}/release.out"
release_result="$(awk -F= '$1 == "result" { print $2 }' <"${staging}/release.out")"
manifest_key="$(awk -F= '$1 == "manifest_key" { print $2 }' <"${staging}/release.out")"

# 3 + 4. Archive the world and upload it, both through the existing verified paths.
SPAWNPOINT_GAME="${game}" \
SERVER_DATA_DIR="${data_dir}" \
SERVER_BACKUP_DIR="${staging}/backups" \
WORLD_NAME="${world_name}" \
  "${SERVER_SCRIPTS}/archive-world.sh" >"${staging}/archive.out"
archive="$(awk -F= '$1 == "archive" { print $2 }' <"${staging}/archive.out")"

SPAWNPOINT_GAME="${game}" \
WORLD_NAME="${world_name}" \
  "${SERVER_SCRIPTS}/upload-world-backup.sh" "${archive}" >"${staging}/backup.out"
archive_key="$(awk -F= '$1 == "object_key" { print $2 }' <"${staging}/backup.out")"

# 5. The pointer, last: desired is what was imported, active stays null until a
#    start passes the health check (ADR-0030).
jq -n \
  --arg world "${world_name}" \
  --arg release "${release}" \
  --arg updated_at "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" \
  --arg updated_by "${actor}" \
  '{
    schema_version: 1,
    world: $world,
    desired_release: $release,
    active_release: null,
    updated_at: $updated_at,
    updated_by: $updated_by,
    source: "import-world"
  }' >"${staging}/release-pointer.json"

pointer_digest="$(sha256sum -- "${staging}/release-pointer.json")"
pointer_digest="${pointer_digest%% *}"
aws --region "${AWS_REGION}" --no-cli-pager s3api put-object \
  --bucket "${RELEASE_BUCKET}" \
  --key "${pointer_key}" \
  --body "${staging}/release-pointer.json" \
  --metadata "sha256=${pointer_digest},world=${world_name}" \
  >/dev/null

printf 'result=imported\n'
printf 'world=%s\n' "${world_name}"
printf 'game=%s\n' "${game}"
printf 'release=%s\n' "${release}"
printf 'release_result=%s\n' "${release_result}"
printf 'manifest_key=%s\n' "${manifest_key}"
printf 'archive_key=%s\n' "${archive_key}"
printf 'pointer_key=%s\n' "${pointer_key}"
printf 'desired_release=%s\n' "${release}"
printf 'active_release=null\n'
