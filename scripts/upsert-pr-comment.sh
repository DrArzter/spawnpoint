#!/usr/bin/env bash

set -Eeuo pipefail

marker="${1:?usage: upsert-pr-comment.sh <marker> <body-file>}"
body_file="${2:?usage: upsert-pr-comment.sh <marker> <body-file>}"
: "${GH_TOKEN:?GH_TOKEN is required}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
: "${PR_NUMBER:?PR_NUMBER is required}"
[[ -s "${body_file}" ]] || {
  printf 'error: comment body is empty: %s\n' "${body_file}" >&2
  exit 1
}

comment_id="$(
  gh api --paginate --slurp "repos/${GITHUB_REPOSITORY}/issues/${PR_NUMBER}/comments?per_page=100" \
    | jq -r --arg marker "${marker}" \
      'map(.[]) | map(select(.user.login == "github-actions[bot]" and (.body | contains($marker)))) | last | .id // empty'
)"

if [[ -n "${comment_id}" ]]; then
  gh api --method PATCH "repos/${GITHUB_REPOSITORY}/issues/comments/${comment_id}" -F "body=@${body_file}" >/dev/null
  printf 'result=updated comment_id=%s\n' "${comment_id}"
else
  gh api --method POST "repos/${GITHUB_REPOSITORY}/issues/${PR_NUMBER}/comments" -F "body=@${body_file}" >/dev/null
  printf 'result=created\n'
fi
