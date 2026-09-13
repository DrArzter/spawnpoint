#!/usr/bin/env bash

# CodeBuild entrypoint for projecting one verified preset snapshot into the
# control-plane catalog. The snapshot is data: no script from it is executed.

set -Eeuo pipefail

repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/_config-source.sh
source "${repository_root}/scripts/_config-source.sh"

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
  jq -e --arg id "${directory_id}" '
    .schema_version == 1
    and .id == $id
    and (.id | test("^[a-z0-9][a-z0-9-]{0,31}$"))
    and (.display_name | type == "string" and length > 0 and length <= 80)
    and ((.game // "minecraft") | test("^[a-z0-9][a-z0-9-]{0,31}$"))
  ' "${profile}" >/dev/null || {
    printf 'error: invalid profile metadata: %s\n' "${directory_id}" >&2
    exit 1
  }
  profile_game="$(jq -r '.game // "minecraft"' "${profile}")"
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
  jq -cn \
    --arg id "${directory_id}" \
    --arg display_name "$(jq -r '.display_name' "${profile}")" \
    --arg profile_digest "${digest}" \
    '{id: $id, display_name: $display_name, profile_digest: $profile_digest, build_status: "unbuilt", releases: [], latest_release: null}' \
    >>"${entries}"
done

catalog="${workspace}/catalog.json"
jq -s \
  --arg game "${game}" \
  --arg kind "${CONFIG_SOURCE_KIND}" \
  --arg origin "${source_origin}" \
  --arg revision "${source_revision}" \
  '{schema_version: 2, game: $game, source: {kind: $kind, origin: $origin, revision: $revision, repository: $origin, commit: $revision}, presets: .}' \
  "${entries}" >"${catalog}"

# Preserve a successful build for an unchanged profile. A repository commit
# changes when any preset changes; the profile digest is the narrower identity
# that prevents unrelated edits from making every other preset look unbuilt.
existing="${workspace}/existing.json"
catalog_key="presets/${game}/catalog.json"
if aws s3api get-object --bucket "${RELEASE_BUCKET}" --key "${catalog_key}" "${existing}" >/dev/null 2>&1; then
  jq --slurpfile old "${existing}" '
    .presets |= map(. as $new |
      ([$old[0].presets[]? | select(.id == $new.id and .profile_digest == $new.profile_digest)] | first // null) as $previous |
      if $previous then
        .build_status = $previous.build_status |
        .releases = ($previous.releases // (if $previous.latest_release == null then [] else [$previous.latest_release] end)) |
        .latest_release = $previous.latest_release
      else . end
    )
  ' "${catalog}" >"${catalog}.merged"
  mv -- "${catalog}.merged" "${catalog}"
fi

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
