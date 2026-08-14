#!/usr/bin/env bash

set -Eeuo pipefail

profile="${AWS_PROFILE:-spawnpoint}"
region="${AWS_REGION:-eu-central-1}"
limit=5

if [[ "${1:-}" == "--limit" && "${2:-}" =~ ^[0-9]+$ && $# -eq 2 ]]; then
  limit="$2"
elif [[ $# -gt 0 ]]; then
  printf 'usage: %s [--limit 1..50]\n' "$0" >&2
  exit 1
fi
((limit >= 1 && limit <= 50)) || {
  printf 'error: --limit must be between 1 and 50\n' >&2
  exit 1
}

for command in aws jq; do
  command -v "${command}" >/dev/null 2>&1 || {
    printf 'error: required command not found: %s\n' "${command}" >&2
    exit 1
  }
done

account_id="$(aws sts get-caller-identity --profile "${profile}" --query Account --output text)"
bucket="spawnpoint-backups-${account_id}"
objects="$(
  aws s3api list-objects-v2 \
    --bucket "${bucket}" --prefix worlds/world/archives/ \
    --profile "${profile}" --region "${region}" --output json
)"

printf 'BUCKET\tLAST_MODIFIED\tSIZE_MIB\tSHA256\tKEY\n'
jq -r --arg bucket "${bucket}" --argjson limit "${limit}" '
  [.Contents[]?] | sort_by(.LastModified) | reverse | .[:$limit][]
  | .Key as $key
  | ($key | capture("-(?<sha>[0-9a-f]{64})[.]tar[.]zst$").sha // "unknown") as $sha
  | [$bucket, .LastModified, ((.Size / 1048576 * 100 | round) / 100), $sha, $key]
  | @tsv
' <<<"${objects}"

