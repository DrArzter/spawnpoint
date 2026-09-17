#!/usr/bin/env bash

# Turn `aws ssm get-parameters-by-path --output json` into the .env a host
# runs from: the last segment of each parameter's name is the key. Refuses a
# key that is not a plain environment name and a value that spans lines, so a
# mistyped parameter cannot become a shell fragment.

set -Eeuo pipefail

command -v jq >/dev/null 2>&1 || { printf 'error: required command not found: jq\n' >&2; exit 1; }

input="$(cat)"
jq -e '.Parameters | type == "array" and length > 0' <<<"${input}" >/dev/null || {
  printf 'error: no parameters to render\n' >&2
  exit 1
}
jq -e 'all(.Parameters[]; (.Value | type == "string") and (.Value | test("\n|\r") | not))' <<<"${input}" >/dev/null || {
  printf 'error: a parameter value spans lines\n' >&2
  exit 1
}

# Rows are read into a variable first: a failure inside a process substitution
# would end the loop quietly, and quiet is the one thing this must not be.
rows="$(jq -r '.Parameters | sort_by(.Name)[] | [.Name, .Value] | @tsv' <<<"${input}")"
while IFS=$'\t' read -r name value; do
  [[ -n "${name}" ]] || continue
  key="${name##*/}"
  [[ "${key}" =~ ^[A-Z][A-Z0-9_]*$ ]] || {
    printf 'error: parameter %s does not name an environment variable\n' "${name}" >&2
    exit 1
  }
  printf '%s=%s\n' "${key}" "${value}"
done <<<"${rows}"
