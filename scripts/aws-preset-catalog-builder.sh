#!/usr/bin/env bash

# CodeBuild entrypoint for projecting one verified preset snapshot into the
# control-plane catalog. The snapshot is data: no script from it is executed.

set -Eeuo pipefail

# shellcheck source=../server/games/_legacy-game.sh
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/../server/games/_legacy-game.sh"

repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/_config-source.sh
source "${repository_root}/scripts/_config-source.sh"
# shellcheck source=scripts/_release-holders.sh
source "${repository_root}/scripts/_release-holders.sh"

[[ -n "${RELEASE_BUCKET:-}" && "${RELEASE_BUCKET}" != "REQUIRED_BY_CALLER" ]] || {
  printf 'error: RELEASE_BUCKET is required\n' >&2
  exit 1
}

for command in awk aws find grep jq sha256sum sort tar; do
  command -v "${command}" >/dev/null 2>&1 || {
    printf 'error: required command not found: %s\n' "${command}" >&2
    exit 1
  }
done

workspace="$(mktemp -d /tmp/spawnpoint-preset-catalog.XXXXXXXX)"
cleanup() {
  rm -rf -- "${workspace}"
}
trap cleanup EXIT

materialize_config_source "${workspace}"
checkout="${CONFIG_CHECKOUT}"
source_origin="${CONFIG_SOURCE_ORIGIN}"
source_revision="${CONFIG_SOURCE_REVISION}"

mapfile -t profiles < <(find "${checkout}/profiles" -mindepth 2 -maxdepth 2 -type f -name profile.json -print | sort)
[[ "${#profiles[@]}" -gt 0 ]] || {
  printf 'error: repository contains no profiles\n' >&2
  exit 1
}

entries="${workspace}/entries.jsonl"
game=""
for profile in "${profiles[@]}"; do
  directory="$(dirname -- "${profile}")"
  directory_id="$(basename -- "${directory}")"
  jq -e --arg legacy_game "${LEGACY_GAME_ID}" --arg id "${directory_id}" '
    .schema_version == 1
    and .id == $id
    and (.id | test("^[a-z0-9][a-z0-9-]{0,31}$"))
    and (.display_name | type == "string" and length > 0 and length <= 80)
    and ((.game // $legacy_game) | test("^[a-z0-9][a-z0-9-]{0,31}$"))
  ' "${profile}" >/dev/null || {
    printf 'error: invalid profile metadata: %s\n' "${directory_id}" >&2
    exit 1
  }
  profile_game="$(jq -r --arg legacy_game "${LEGACY_GAME_ID}" '.game // $legacy_game' "${profile}")"
  if [[ -z "${game}" ]]; then
    game="${profile_game}"
  elif [[ "${profile_game}" != "${game}" ]]; then
    printf 'error: one configuration repository cannot mix games\n' >&2
    exit 1
  fi
  digest="$({
    while IFS= read -r -d '' file; do
      relative="${file#"${directory}/"}"
      printf '%s  %s\n' "$(sha256sum -- "${file}" | awk '{print $1}')" "${relative}"
    done < <(find "${directory}" -type f -print0 | sort -z)
  } | sha256sum | awk '{print $1}')"
  profile_revision="${source_revision}"
  if [[ -f "${checkout}/profiles/.source-revisions.json" ]]; then
    profile_revision="$(jq -er --arg id "${directory_id}" '.[$id] // error("missing profile source revision")' "${checkout}/profiles/.source-revisions.json")"
  fi
  jq -cn \
    --arg id "${directory_id}" \
    --arg display_name "$(jq -r '.display_name' "${profile}")" \
    --arg profile_digest "${digest}" \
    --arg source_commit "${profile_revision}" \
    '{id: $id, display_name: $display_name, profile_digest: $profile_digest, source_commit: $source_commit, build_status: "unbuilt", releases: [], latest_release: null}' \
    >>"${entries}"
done

catalog="${workspace}/catalog.json"
jq -s \
  --arg game "${game}" \
  --arg kind "${CONFIG_SOURCE_KIND}" \
  --arg origin "${source_origin}" \
  --arg revision "${source_revision}" \
  --arg snapshot_key "${CONFIG_SOURCE_KEY}" \
  --arg snapshot_sha256 "${CONFIG_SOURCE_SHA256}" \
  '{schema_version: 2, game: $game, source: {kind: $kind, origin: $origin, revision: $revision, repository: $origin, commit: $revision, snapshot: {key: $snapshot_key, sha256: $snapshot_sha256}}, presets: .}' \
  "${entries}" >"${catalog}"

# Carry a preset's release history over from the published catalog (ADR-0042).
# A repository commit changes when any preset changes; the profile digest is the
# narrower identity that prevents unrelated edits from making every other preset
# look unbuilt. The digest decides only the state of the current revision:
#  - the same digest keeps build_status as it was;
#  - a changed digest starts unbuilt, and every earlier release stays listed
#    with the digest and commit it was built from, so a reader can tell that it
#    was built from an older revision.
existing="${workspace}/existing.json"
catalog_key="presets/${game}/catalog.json"
if aws s3api get-object --bucket "${RELEASE_BUCKET}" --key "${catalog_key}" "${existing}" >/dev/null 2>&1; then
  jq --slurpfile old "${existing}" --argjson has_revisions "$(if [[ -f "${checkout}/profiles/.source-revisions.json" ]]; then printf true; else printf false; fi)" '
    .presets |= map(. as $new |
      ([$old[0].presets[]? | select(.id == $new.id)] | first // null) as $previous |
      if $previous == null then .
      else
        ($previous.releases // (if $previous.latest_release == null then [] else [$previous.latest_release] end)) as $releases |
        ($previous.source_commit // $old[0].source.commit) as $previous_commit |
        ($previous.built_from // {}) as $recorded |
        (reduce $releases[] as $release ({};
          .[$release] = ($recorded[$release] // {profile_digest: $previous.profile_digest, source_commit: $previous_commit}))) as $built_from |
        .releases = $releases |
        .latest_release = $previous.latest_release |
        (if ($built_from | length) > 0 then .built_from = $built_from else . end) |
        if $previous.profile_digest == $new.profile_digest then
          .source_commit = (if $has_revisions then .source_commit else $previous_commit end) |
          .build_status = $previous.build_status
        else . end
      end
    )
  ' "${catalog}" >"${catalog}.merged"
  mv -- "${catalog}.merged" "${catalog}"
fi

# A release whose manifest exists in S3 is published, whatever the catalog
# says: a catalog written before this history was kept has forgotten releases
# that a world still runs. A folder without a manifest is a failed build and is
# never listed. The listing is best effort: without it the catalog still
# publishes.
discover_published_releases() {
  local listing key id release manifest listed known="${workspace}/known-releases.txt" found="${workspace}/discovered.jsonl"
  : >"${found}"
  jq -r '.presets[] | .id as $id | (.releases[]?) | "\($id)/\(.)"' "${catalog}" >"${known}"
  listing="$(aws s3api list-objects-v2 --bucket "${RELEASE_BUCKET}" --prefix "releases/${game}/" --output json 2>/dev/null | jq -r '(.Contents // [])[].Key')" || {
    printf 'warning: could not list published releases\n' >&2
    return 0
  }
  while IFS= read -r key; do
    [[ "${key}" =~ ^releases/${game}/([a-z0-9][a-z0-9-]{0,31})/([0-9]+\.[0-9]+)/manifest\.json$ ]] || continue
    id="${BASH_REMATCH[1]}"
    release="${BASH_REMATCH[2]}"
    listed=false
    grep -qxF -- "${id}/${release}" "${known}" && listed=true
    jq -e --arg id "${id}" '.presets | any(.id == $id)' "${catalog}" >/dev/null || continue
    manifest="${workspace}/discovered-manifest.json"
    aws s3api get-object --bucket "${RELEASE_BUCKET}" --key "${key}" "${manifest}" >/dev/null 2>&1 || continue
    jq -ce --arg legacy_game "${LEGACY_GAME_ID}" --arg game "${game}" --arg id "${id}" --arg release "${release}" --argjson listed "${listed}" '
      select((.game // $legacy_game) == $game and .release == $release and .source_profile.id == $id
        and (.source_profile.commit | type == "string" and test("^[0-9a-f]{40}$")) and (.created_at | type == "string"))
      | {id: $id, release: $release, created_at: .created_at, source_commit: .source_profile.commit, listed: $listed}
    ' "${manifest}" >>"${found}" || true
  done <<<"${listing}"
  # releases is oldest first: a build appends, and promotion offers only the
  # releases after a world's active one. Recovered releases are older than the
  # ones the catalog kept, so every list is ordered by its manifests' created_at.
  # A listed release without a manifest keeps its place at the front.
  jq --slurpfile found "${found}" '
    .presets |= map(. as $preset |
      [$found[] | select(.id == $preset.id)] as $manifests |
      ($manifests | map(select(.listed | not)) | sort_by(.created_at)) as $recovered |
      ($manifests | map({key: .release, value: .created_at}) | from_entries) as $created |
      if ($manifests | length) == 0 then .
      else
        .releases = ((.releases // []) + ($recovered | map(.release))
          | to_entries | sort_by([($created[.value] // ""), .key]) | map(.value)) |
        if ($recovered | length) == 0 then .
        else
          .built_from = ((.built_from // {}) + ($recovered | map({key: .release, value: {profile_digest: null, source_commit: .source_commit}}) | from_entries)) |
          .latest_release = (.latest_release // ($recovered | last | .release))
        end
      end
    )
  ' "${catalog}" >"${catalog}.discovered"
  mv -- "${catalog}.discovered" "${catalog}"
}
discover_published_releases

# Holder first (ADR-0080): every release the catalog lists is held before the
# catalog is written. A failure stops here, and the old catalog stays.
hold_catalog_releases "${catalog}" "${game}"

aws s3api put-object \
  --bucket "${RELEASE_BUCKET}" \
  --key "${catalog_key}" \
  --body "${catalog}" \
  --server-side-encryption AES256 \
  --content-type application/json \
  >/dev/null

printf 'result=preset_catalog_ready\n'
printf 'game=%s\n' "${game}"
printf 'source_kind=%s\n' "${CONFIG_SOURCE_KIND}"
printf 'source_revision=%s\n' "${source_revision}"
printf 'config_commit=%s\n' "${source_revision}"
printf 'presets=%s\n' "${#profiles[@]}"
printf 'catalog_key=%s\n' "${catalog_key}"
