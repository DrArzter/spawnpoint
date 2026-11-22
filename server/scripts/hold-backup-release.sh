#!/usr/bin/env bash

# Holds a release for one new backup (ADR-0080): the item hold#backup#<key>#<version>
# on the release, with role "backup", and the release's holder count. It refuses a
# release that is not live, as ReleaseRefs.hold does. It needs the version id of
# the upload, so it runs after the upload. The caller keeps the archive when it fails.
#
# usage: hold-backup-release.sh <game> <preset> <release> <archive-key> <version-id>
# Needs AWS_REGION; RELEASE_REFS_TABLE is optional.

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_common.sh
source "${SCRIPT_DIR}/_common.sh"

game="${1:-}"
preset="${2:-}"
release="${3:-}"
archive_key="${4:-}"
version_id="${5:-}"

[[ $# -eq 5 ]] || die "usage: hold-backup-release.sh <game> <preset> <release> <archive-key> <version-id>"
require_command aws
require_command jq
[[ "${game}" =~ ^[a-z0-9][a-z0-9-]{0,31}$ ]] || die "invalid game: ${game}"
[[ "${preset}" =~ ^[a-z0-9][a-z0-9-]{0,31}$ ]] || die "invalid preset: ${preset}"
[[ "${release}" =~ ^[0-9]+\.[0-9]+$ ]] || die "invalid release: ${release}"
[[ "${archive_key}" =~ ^worlds/[a-z0-9][a-z0-9-]{0,31}/archives/[A-Za-z0-9._-]+\.tar\.zst$ ]] || die "invalid archive key: ${archive_key}"
[[ "${version_id}" =~ ^[A-Za-z0-9._-]+$ ]] || die "invalid version id"

table="${RELEASE_REFS_TABLE:-spawnpoint-release-refs}"
pk="release#${game}/${preset}/${release}"
sk="hold#backup#${archive_key}#${version_id}"

ddb() {
  aws --region "${AWS_REGION:-eu-central-1}" --no-cli-pager dynamodb "$@"
}

item_key() {
  jq -nc --arg pk "$1" --arg sk "$2" '{pk: {S: $pk}, sk: {S: $sk}}'
}

existing="$(ddb get-item --table-name "${table}" --key "$(item_key "${pk}" "${sk}")" --consistent-read --output json)" ||
  die "could not read the backup holder of ${pk}"
if jq -e 'has("Item")' <<<"${existing}" >/dev/null; then
  printf 'result=already_held\n'
  exit 0
fi

# The holder and the count change together, and only for a live release.
items="$(jq -nc --arg table "${table}" --arg pk "${pk}" --arg sk "${sk}" --arg now "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" '[
  {Put: {TableName: $table, Item: {pk: {S: $pk}, sk: {S: $sk}, roles: {SS: ["backup"]}, added_at: {S: $now}},
         ConditionExpression: "attribute_not_exists(pk)"}},
  {Update: {TableName: $table, Key: {pk: {S: $pk}, sk: {S: "meta"}},
            UpdateExpression: "ADD holders :one", ConditionExpression: "#s = :live",
            ExpressionAttributeNames: {"#s": "state"}, ExpressionAttributeValues: {":one": {N: "1"}, ":live": {S: "live"}}}}
]')"
if ! ddb transact-write-items --transact-items "${items}" >/dev/null 2>&1; then
  meta="$(ddb get-item --table-name "${table}" --key "$(item_key "${pk}" meta)" --consistent-read --output json 2>/dev/null)" || meta="{}"
  state="$(jq -r '.Item.state.S // "not registered"' <<<"${meta}" 2>/dev/null)" || state="unknown"
  die "the backup holder was not written: release ${game}/${preset}/${release} is ${state}"
fi
printf 'result=held\n'
