#!/usr/bin/env bash

# Transitional manual bootstrap/diagnostic tool. The production path is GitHub
# Actions -> AWS workflow -> ephemeral AWS builder; do not make a workstation a
# release dependency. This script still exercises the same immutable artefact
# contract while that AWS builder is being implemented.
#
# Cut an immutable release from a pinned mod list: resolve the pins from
# CurseForge, build the manifest, publish payload and manifest to the release
# bucket. Deliberately stops there — cutting is not deploying. The gate between
# them is a promotion (ADR-0028, ADR-0030): scripts/promote-release.sh.

set -Eeuo pipefail

REPOSITORY_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
SERVER_SCRIPTS="${REPOSITORY_ROOT}/server/scripts"

usage() {
  cat >&2 <<'EOF'
usage: cut-release.sh <mod-list> <release> <minecraft-version> <loader-version>

Environment:
  CF_API_KEY         required; never lands in any output or manifest
  AWS_PROFILE        defaults to spawnpoint
  AWS_REGION         defaults to eu-central-1
  RELEASE_BUCKET     defaults to spawnpoint-releases-<account-id>
  RELEASE_CHANGELOG  recorded in the manifest; defaults to "Cut from <list>"
  RELEASE_PROFILE_ID, RELEASE_PROFILE_REPOSITORY and RELEASE_PROFILE_COMMIT
                     required release provenance; use the preset and exact Git revision
EOF
}

[[ $# -eq 4 ]] || {
  usage
  exit 2
}

mod_list="$1"
release="$2"
minecraft_version="$3"
loader_version="$4"

export AWS_PROFILE="${AWS_PROFILE:-spawnpoint}"
export AWS_REGION="${AWS_REGION:-eu-central-1}"

for command in aws jq curl sha256sum; do
  command -v "${command}" >/dev/null 2>&1 || {
    printf 'error: required command not found: %s\n' "${command}" >&2
    exit 1
  }
done
[[ -n "${CF_API_KEY:-}" ]] || {
  printf 'error: CF_API_KEY is required\n' >&2
  exit 1
}
for variable in RELEASE_PROFILE_ID RELEASE_PROFILE_REPOSITORY RELEASE_PROFILE_COMMIT; do
  [[ -n "${!variable:-}" ]] || {
    printf 'error: %s is required\n' "${variable}" >&2
    exit 1
  }
done

mod_list="$(realpath -e -- "${mod_list}")" || exit 1
[[ "${release}" =~ ^[0-9]+\.[0-9]+$ ]] || {
  printf 'error: release must use MAJOR.MINOR: %s\n' "${release}" >&2
  exit 1
}

if [[ -z "${RELEASE_BUCKET:-}" ]]; then
  account_id="$(aws sts get-caller-identity --query Account --output text)"
  [[ "${account_id}" =~ ^[0-9]{12}$ ]] || {
    printf 'error: could not resolve the AWS account id\n' >&2
    exit 1
  }
fi
export RELEASE_BUCKET="${RELEASE_BUCKET:-spawnpoint-releases-${account_id}}"

staging="$(mktemp -d /tmp/spawnpoint-cut.XXXXXXXX)"
cleanup() {
  rm -rf -- "${staging}"
}
trap cleanup EXIT

"${SERVER_SCRIPTS}/resolve-mod-list.sh" "${mod_list}" "${staging}" >"${staging}/resolve.out"
resolved="$(awk -F= '$1 == "resolved" { print $2 }' <"${staging}/resolve.out")"
downloaded="$(awk -F= '$1 == "downloaded" { print $2 }' <"${staging}/resolve.out")"

RELEASE_CREATED_BY="${USER:-cut-release}" \
RELEASE_CHANGELOG="${RELEASE_CHANGELOG:-Cut from $(basename -- "${mod_list}")}" \
  "${SERVER_SCRIPTS}/build-release-manifest.sh" \
  "${release}" "${minecraft_version}" "${loader_version}" "${staging}/mods" "${staging}/manifest.json" >/dev/null

"${SERVER_SCRIPTS}/upload-release.sh" "${staging}/manifest.json" >"${staging}/upload.out"
upload_result="$(awk -F= '$1 == "result" { print $2 }' <"${staging}/upload.out")"
manifest_key="$(awk -F= '$1 == "manifest_key" { print $2 }' <"${staging}/upload.out")"

pack_result="$(awk -F= '$1 == "pack" { print $2 }' <"${staging}/upload.out")"
pack_key="$(awk -F= '$1 == "pack_key" { print $2 }' <"${staging}/upload.out")"

printf 'result=cut\n'
printf 'release=%s\n' "${release}"
printf 'mods=%s\n' "${resolved}"
printf 'downloaded=%s\n' "${downloaded}"
printf 'upload=%s\n' "${upload_result}"
printf 'manifest_key=%s\n' "${manifest_key}"
printf 'pack=%s\n' "${pack_result}"
printf 'pack_key=%s\n' "${pack_key}"
printf 'next=scripts/promote-release.sh <world> %s\n' "${release}"
