#!/usr/bin/env bash

# Upstream cache for the release builder (incremental builds, stage 3). Bytes a
# build already verified against CurseForge or a pinned SHA-512 are kept under
# upstream/ in the release bucket, so the next build of the same pin reads them
# from S3. The cache is an optimisation only: every failure here is a miss, and
# the caller then fetches from upstream as before. It is off unless
# UPSTREAM_CACHE_BUCKET is set.
#
# Keys (a 60-day lifecycle expiry covers the whole prefix):
#   upstream/curseforge/<project>/<file>/file              verified bytes
#   upstream/curseforge/<project>/<file>/index.json        fileName, fileLength, sha1, sha256, classId
#   upstream/curseforge/<project>/<file>/mirror/<sha512>   the pack's pinned client mirror
#   upstream/modrinth/<version_id>/<sha512>                a Modrinth addon
#
# Without s3:ListBucket S3 answers a missing key with 403, not 404. Both are a
# miss here.
# shellcheck shell=bash

# shellcheck source=_s3.sh
source "${SCRIPT_DIR}/_s3.sh"

UPSTREAM_CACHE_EVENTS=""

# Events go to a file in the caller's workspace, so parallel jobs can count.
upstream_cache_start() {
  UPSTREAM_CACHE_EVENTS="$1/upstream-cache-events"
}

upstream_cache_enabled() {
  [[ -n "${UPSTREAM_CACHE_BUCKET:-}" ]]
}

upstream_cache_require() {
  upstream_cache_enabled || return 0
  [[ "${UPSTREAM_CACHE_BUCKET}" =~ ^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$ ]] ||
    die "invalid UPSTREAM_CACHE_BUCKET: ${UPSTREAM_CACHE_BUCKET}"
  require_command aws
  require_command openssl
}

# One short line per event; parallel writers append whole lines.
upstream_cache_event() {
  [[ -z "${UPSTREAM_CACHE_EVENTS}" ]] || printf '%s %s\n' "$1" "$2" >>"${UPSTREAM_CACHE_EVENTS}"
}

# Prints hits, misses and rejected entries as key=value lines.
upstream_cache_summary() {
  upstream_cache_enabled || return 0
  local hits=0 misses=0 rejected=0
  if [[ -n "${UPSTREAM_CACHE_EVENTS}" && -f "${UPSTREAM_CACHE_EVENTS}" ]]; then
    hits="$(awk '$1 == "hit" { n++ } END { print n + 0 }' "${UPSTREAM_CACHE_EVENTS}")"
    misses="$(awk '$1 == "miss" { n++ } END { print n + 0 }' "${UPSTREAM_CACHE_EVENTS}")"
    rejected="$(awk '$1 == "rejected" { n++ } END { print n + 0 }' "${UPSTREAM_CACHE_EVENTS}")"
  fi
  printf 'upstream_cache_hits=%s\n' "${hits}"
  printf 'upstream_cache_misses=%s\n' "${misses}"
  printf 'upstream_cache_rejected=%s\n' "${rejected}"
}

upstream_cache_curseforge_prefix() {
  local project="$1" file="$2"
  [[ "${project}" =~ ^[1-9][0-9]*$ && "${file}" =~ ^[1-9][0-9]*$ ]] || return 1
  printf 'upstream/curseforge/%s/%s\n' "${project}" "${file}"
}

upstream_cache_get() {
  local key="$1" destination="$2"
  rm -f -- "${destination}"
  s3_cli get-object --bucket "${UPSTREAM_CACHE_BUCKET}" --key "${key}" "${destination}" >/dev/null 2>&1 &&
    [[ -f "${destination}" ]]
}

upstream_cache_put() {
  local key="$1" source="$2" content_type="${3:-application/octet-stream}"
  s3_cli put-object \
    --bucket "${UPSTREAM_CACHE_BUCKET}" \
    --key "${key}" \
    --body "${source}" \
    --checksum-sha256 "$(archive_checksum_base64 "${source}")" \
    --server-side-encryption AES256 \
    --content-type "${content_type}" \
    >/dev/null 2>&1
}

# Reads and checks the index of one CurseForge file into <out>. A missing or
# malformed index is a miss.
upstream_cache_curseforge_index() {
  local project="$1" file="$2" out="$3" prefix
  upstream_cache_enabled || return 1
  prefix="$(upstream_cache_curseforge_prefix "${project}" "${file}")" || return 1
  if ! upstream_cache_get "${prefix}/index.json" "${out}" ||
    ! jq -e --argjson project "${project}" --argjson file "${file}" '
      .schema_version == 1 and .project_id == $project and .file_id == $file and
      (.fileName | type == "string" and test("^[^/\\\\\\t\\r\\n]+\\.(jar|zip)$"; "i")) and
      (.fileLength | type == "number" and floor == . and . > 0) and
      (.sha1 | type == "string" and test("^[0-9a-f]{40}$")) and
      (.sha256 | type == "string" and test("^[0-9a-f]{64}$")) and
      (.classId == null or (.classId | type == "number" and floor == .))
    ' "${out}" >/dev/null 2>&1; then
    rm -f -- "${out}"
    upstream_cache_event miss "curseforge:${project}:${file}"
    return 1
  fi
}

# Copies the cached bytes named by <index> to <destination>. A hit needs the
# size and SHA-256 the index holds; anything else is rejected and removed.
upstream_cache_curseforge_bytes() {
  local project="$1" file="$2" index="$3" destination="$4" prefix actual
  prefix="$(upstream_cache_curseforge_prefix "${project}" "${file}")" || return 1
  if ! upstream_cache_get "${prefix}/file" "${destination}"; then
    upstream_cache_event miss "curseforge:${project}:${file}"
    return 1
  fi
  actual="$(sha256sum -- "${destination}")"
  if [[ "${actual%% *}" != "$(jq -r '.sha256' "${index}")" ||
    "$(stat --format '%s' -- "${destination}")" != "$(jq -r '.fileLength' "${index}")" ]]; then
    rm -f -- "${destination}"
    upstream_cache_event rejected "curseforge:${project}:${file}"
    return 1
  fi
  upstream_cache_event hit "curseforge:${project}:${file}"
}

# A hit for a caller that already holds fresh CurseForge metadata: the index
# must also agree with that metadata's SHA-1 and size.
upstream_cache_curseforge_fetch() {
  local project="$1" file="$2" destination="$3" expected_sha1="$4" expected_bytes="$5" index
  upstream_cache_enabled || return 1
  index="${destination}.index.json"
  upstream_cache_curseforge_index "${project}" "${file}" "${index}" || return 1
  if [[ "$(jq -r '.sha1' "${index}")" != "${expected_sha1}" ||
    "$(jq -r '.fileLength' "${index}")" != "${expected_bytes}" ]]; then
    rm -f -- "${index}"
    upstream_cache_event rejected "curseforge:${project}:${file}"
    return 1
  fi
  upstream_cache_curseforge_bytes "${project}" "${file}" "${index}" "${destination}" || {
    rm -f -- "${index}"
    return 1
  }
  rm -f -- "${index}"
}

# Stores bytes that already passed the CurseForge SHA-1 and size check. The
# check is repeated here, so nothing else can enter the cache. The index goes
# last: a reader trusts bytes only through it. A failed put is a warning.
upstream_cache_curseforge_store() {
  local project="$1" file="$2" source="$3" file_name="$4" expected_sha1="$5" expected_bytes="$6"
  local class_id="${7:-null}" prefix actual_sha1 sha256 index
  upstream_cache_enabled || return 0
  prefix="$(upstream_cache_curseforge_prefix "${project}" "${file}")" || return 0
  # CurseForge's own integrity field, as in the resolvers; not a signature.
  actual_sha1="$(sha1sum -- "${source}")" # NOSONAR
  [[ "${actual_sha1%% *}" == "${expected_sha1}" &&
    "$(stat --format '%s' -- "${source}")" == "${expected_bytes}" ]] || {
    log "warning: upstream cache refused ${project}:${file}: bytes do not match CurseForge SHA-1 and size"
    return 0
  }
  sha256="$(sha256sum -- "${source}")"
  index="${source}.cache-index.json"
  jq -n --argjson project "${project}" --argjson file "${file}" --arg name "${file_name}" \
    --argjson bytes "${expected_bytes}" --arg sha1 "${expected_sha1}" --arg sha256 "${sha256%% *}" \
    --argjson class "${class_id}" \
    '{schema_version:1,project_id:$project,file_id:$file,fileName:$name,fileLength:$bytes,
      sha1:$sha1,sha256:$sha256,classId:$class}' >"${index}"
  if upstream_cache_put "${prefix}/file" "${source}" &&
    upstream_cache_put "${prefix}/index.json" "${index}" application/json; then
    upstream_cache_event stored "curseforge:${project}:${file}"
  else
    log "warning: upstream cache could not store ${project}:${file}"
  fi
  rm -f -- "${index}"
}

# Content keyed by a pinned SHA-512 checks itself: a hit needs that digest and
# the pinned size.
upstream_cache_sha512_fetch() {
  local key="$1" destination="$2" expected_sha512="$3" expected_bytes="$4" actual
  upstream_cache_enabled || return 1
  if ! upstream_cache_get "${key}" "${destination}"; then
    upstream_cache_event miss "${key}"
    return 1
  fi
  actual="$(sha512sum -- "${destination}")"
  if [[ "${actual%% *}" != "${expected_sha512}" ||
    "$(stat --format '%s' -- "${destination}")" != "${expected_bytes}" ]]; then
    rm -f -- "${destination}"
    upstream_cache_event rejected "${key}"
    return 1
  fi
  upstream_cache_event hit "${key}"
}

upstream_cache_sha512_store() {
  local key="$1" source="$2" expected_sha512="$3" expected_bytes="$4" actual
  upstream_cache_enabled || return 0
  actual="$(sha512sum -- "${source}")"
  [[ "${actual%% *}" == "${expected_sha512}" &&
    "$(stat --format '%s' -- "${source}")" == "${expected_bytes}" ]] || {
    log "warning: upstream cache refused ${key}: bytes do not match the pinned SHA-512 and size"
    return 0
  }
  if upstream_cache_put "${key}" "${source}"; then
    upstream_cache_event stored "${key}"
  else
    log "warning: upstream cache could not store ${key}"
  fi
}

upstream_cache_mirror_key() {
  local project="$1" file="$2" sha512="$3" prefix
  prefix="$(upstream_cache_curseforge_prefix "${project}" "${file}")" || return 1
  [[ "${sha512}" =~ ^[0-9a-f]{128}$ ]] || return 1
  printf '%s/mirror/%s\n' "${prefix}" "${sha512}"
}

upstream_cache_modrinth_key() {
  local version_id="$1" sha512="$2"
  [[ "${version_id}" =~ ^[A-Za-z0-9]{8}$ && "${sha512}" =~ ^[0-9a-f]{128}$ ]] || return 1
  printf 'upstream/modrinth/%s/%s\n' "${version_id}" "${sha512}"
}
