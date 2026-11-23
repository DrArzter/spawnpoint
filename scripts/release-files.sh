#!/usr/bin/env bash

# A person's view of the release bucket. Under objects-v1 (ADR-0080) a file is
# an object named by its SHA-256, with no name or extension; the manifest is
# the only map from names to objects. This tool reads that map, in both
# layouts. It only lists keys and reads manifests: it changes nothing.

set -Eeuo pipefail

usage() {
  cat >&2 <<'EOF'
usage:
  release-files.sh show <game> <preset> <release>
      every file of one release: kind, path, bytes, SHA-256 and its S3 key
  release-files.sh find <game> <text>
      the releases of a game with a file whose name contains <text> (any case)
  release-files.sh object <sha256 | objects/sha256/<xx>/<sha256>>
      whether the object is stored, and every release and file that names it

Output is tab-separated with a header line; on a terminal it is aligned.

Environment:
  AWS_PROFILE     defaults to spawnpoint
  AWS_REGION      defaults to eu-central-1
  RELEASE_BUCKET  defaults to spawnpoint-releases-<account-id>
EOF
}

export AWS_PROFILE="${AWS_PROFILE:-spawnpoint}"
export AWS_REGION="${AWS_REGION:-eu-central-1}"

fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

for command in aws jq; do
  command -v "${command}" >/dev/null 2>&1 || fail "required command not found: ${command}"
done

command="${1:-}"
case "${command}" in
  show) [[ $# -eq 4 ]] || { usage; exit 2; } ;;
  find) [[ $# -eq 3 && -n "$3" ]] || { usage; exit 2; } ;;
  object) [[ $# -eq 2 ]] || { usage; exit 2; } ;;
  *) usage; exit 2 ;;
esac

id_pattern='^[a-z0-9][a-z0-9-]{0,31}$'
[[ "${command}" == object || "$2" =~ ${id_pattern} ]] || { printf 'error: invalid game id: %s\n' "$2" >&2; exit 2; }
if [[ "${command}" == show ]]; then
  [[ "$3" =~ ${id_pattern} ]] || { printf 'error: invalid preset id: %s\n' "$3" >&2; exit 2; }
  [[ "$4" =~ ^[0-9]+\.[0-9]+$ ]] || { printf 'error: release must use MAJOR.MINOR: %s\n' "$4" >&2; exit 2; }
fi

if [[ -z "${RELEASE_BUCKET:-}" ]]; then
  account_id="$(aws sts get-caller-identity --query Account --output text)"
  [[ "${account_id}" =~ ^[0-9]{12}$ ]] || fail "could not resolve the AWS account id"
  RELEASE_BUCKET="spawnpoint-releases-${account_id}"
fi

workspace="$(mktemp -d "${TMPDIR:-/tmp}/spawnpoint-release-files.XXXXXXXX")"
trap 'rm -rf -- "${workspace}"' EXIT

# Tab-separated rows; aligned columns for a person at a terminal.
emit() {
  if [[ -t 1 ]] && command -v column >/dev/null 2>&1; then
    column -t -s $'\t'
  else
    cat
  fi
}

# Keys and sizes under a prefix, one "key<TAB>size" line each; the CLI pages.
list_keys() {
  local prefix="$1"
  aws s3api list-objects-v2 --bucket "${RELEASE_BUCKET}" --prefix "${prefix}" --output json |
    jq -r '(.Contents // [])[] | [.Key, (.Size | tostring)] | @tsv'
}

# The manifest of one release into a file; fails when it is not published.
read_manifest() {
  local key="$1" target="$2"
  aws s3api get-object --bucket "${RELEASE_BUCKET}" --key "${key}" "${target}" >/dev/null 2>&1 ||
    fail "no manifest at s3://${RELEASE_BUCKET}/${key}"
  jq -e 'type == "object"' "${target}" >/dev/null 2>&1 || fail "s3://${RELEASE_BUCKET}/${key} is not a JSON object"
}

# Every published manifest under a prefix: releases/<game>/<preset>/<release>/manifest.json.
manifest_keys() {
  local prefix="$1"
  list_keys "${prefix}" | cut -f1 | grep -E '^releases/[a-z0-9][a-z0-9-]{0,31}/[a-z0-9][a-z0-9-]{0,31}/[0-9]+\.[0-9]+/manifest\.json$' || true
}

# One row per file the manifest names: kind, path, bytes, sha256. Packs carry
# a digest only where the manifest records one.
manifest_files() {
  local manifest="$1"
  jq -r '
    ((.server.mods // [])[] | ["mod", "mods/" + .file, .bytes, .sha256]),
    ((.server.overrides // [])[] | ["override", "overrides/" + .path, .bytes, .sha256]),
    (if (.client.sha256 | type) == "string" then ["pack", "client.zip", .client.bytes, .client.sha256] else empty end),
    ((.packs // {}) | to_entries[] | select(.value.sha256 | type == "string") |
      ["pack", .key + ".zip", .value.bytes, .value.sha256])
    | map(tostring) | @tsv
  ' "${manifest}"
}

layout_of() {
  local manifest="$1"
  jq -r '.storage.layout // "legacy"' "${manifest}"
}

object_key() {
  local digest="$1"
  printf 'objects/sha256/%s/%s' "${digest:0:2}" "${digest}"
}

show_release() {
  local game="$1" preset="$2" release="$3" prefix manifest layout kind path bytes sha key size listed
  prefix="releases/${game}/${preset}/${release}"
  manifest="${workspace}/manifest.json"
  read_manifest "${prefix}/manifest.json" "${manifest}"
  layout="$(layout_of "${manifest}")"
  {
    printf '# release %s/%s/%s, layout %s, created %s, source %s@%s\n' "${game}" "${preset}" "${release}" "${layout}" \
      "$(jq -r '.created_at // "unknown"' "${manifest}")" \
      "$(jq -r '.source_profile.repository // "unknown"' "${manifest}")" \
      "$(jq -r '.source_profile.commit // "unknown"' "${manifest}" | cut -c1-12)"
  } >&2
  {
    printf 'kind\tpath\tbytes\tsha256\ts3_key\n'
    if [[ "${layout}" == legacy ]]; then
      # A legacy pack sits beside the files; the manifest may not record its digest.
      listed="${workspace}/listed.tsv"
      list_keys "${prefix}/" >"${listed}"
      while IFS=$'\t' read -r kind path bytes sha; do
        printf '%s\t%s\t%s\t%s\t%s\n' "${kind}" "${path}" "${bytes}" "${sha}" "${prefix}/${path}"
      done < <(manifest_files "${manifest}")
      for path in client.zip server.zip full.zip; do
        key="${prefix}/${path}"
        size="$(awk -F'\t' -v key="${key}" '$1 == key { print $2 }' "${listed}")"
        [[ -n "${size}" ]] || continue
        if [[ "${path}" == client.zip ]] && jq -e '(.client.sha256 | type) == "string"' "${manifest}" >/dev/null; then
          continue
        fi
        printf 'pack\t%s\t%s\t-\t%s\n' "${path}" "${size}" "${key}"
      done
    else
      while IFS=$'\t' read -r kind path bytes sha; do
        printf '%s\t%s\t%s\t%s\t%s\n' "${kind}" "${path}" "${bytes}" "${sha}" "$(object_key "${sha}")"
      done < <(manifest_files "${manifest}")
    fi
  } | emit
}

find_name() {
  local game="$1" text="$2" key manifest preset release kind path bytes sha
  {
    printf 'preset\trelease\tkind\tpath\tbytes\tsha256\n'
    while read -r key; do
      manifest="${workspace}/find.json"
      read_manifest "${key}" "${manifest}"
      preset="$(cut -d/ -f3 <<<"${key}")"
      release="$(cut -d/ -f4 <<<"${key}")"
      while IFS=$'\t' read -r kind path bytes sha; do
        printf '%s\t%s\t%s\t%s\t%s\t%s\n' "${preset}" "${release}" "${kind}" "${path}" "${bytes}" "${sha}"
      done < <(manifest_files "${manifest}" | awk -F'\t' -v text="${text}" 'index(tolower($2), tolower(text)) > 0')
    done < <(manifest_keys "releases/${game}/")
  } | emit
}

find_object() {
  local wanted="$1" sha key manifest game preset release stored kind path
  sha="${wanted##*/}"
  [[ "${sha}" =~ ^[0-9a-f]{64}$ ]] || { printf 'error: not a SHA-256 digest or object key: %s\n' "${wanted}" >&2; exit 2; }
  stored="$(list_keys "$(object_key "${sha}")" | awk -F'\t' -v key="$(object_key "${sha}")" '$1 == key { print $2 }')"
  if [[ -n "${stored}" ]]; then
    printf '# object %s is stored, %s bytes\n' "$(object_key "${sha}")" "${stored}" >&2
  else
    printf '# object %s is not in the store; a legacy release may still hold these bytes under its own key\n' \
      "$(object_key "${sha}")" >&2
  fi
  {
    printf 'game\tpreset\trelease\tlayout\tkind\tpath\n'
    while read -r key; do
      manifest="${workspace}/object.json"
      read_manifest "${key}" "${manifest}"
      IFS=/ read -r _ game preset release _ <<<"${key}"
      while IFS=$'\t' read -r kind path _ _; do
        printf '%s\t%s\t%s\t%s\t%s\t%s\n' "${game}" "${preset}" "${release}" "$(layout_of "${manifest}")" "${kind}" "${path}"
      done < <(manifest_files "${manifest}" | awk -F'\t' -v sha="${sha}" '$4 == sha')
    done < <(manifest_keys "releases/")
  } | emit
}

case "${command}" in
  show) show_release "$2" "$3" "$4" ;;
  find) find_name "$2" "$3" ;;
  object) find_object "$2" ;;
  *) usage; exit 2 ;;
esac
