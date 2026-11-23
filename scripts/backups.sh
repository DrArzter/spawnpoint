#!/usr/bin/env bash

set -Eeuo pipefail

profile="${AWS_PROFILE:-spawnpoint}"
region="${AWS_REGION:-eu-central-1}"
limit=5
# Every world's archives by default; --world names one (worlds/<id>/archives/).
prefix="worlds/"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --limit)
      [[ "${2:-}" =~ ^[0-9]+$ ]] || { printf 'error: --limit needs a number\n' >&2; exit 1; }
      limit="$2"
      shift 2
      ;;
    --world)
      [[ "${2:-}" =~ ^[a-z0-9][a-z0-9-]{0,31}$ ]] || { printf 'error: --world needs a world id\n' >&2; exit 1; }
      prefix="worlds/$2/archives/"
      shift 2
      ;;
    *)
      printf 'usage: %s [--world <world-id>] [--limit 1..50]\n' "$0" >&2
      exit 1
      ;;
  esac
done
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
    --bucket "${bucket}" --prefix "${prefix}" \
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

