#!/usr/bin/env bash

# CodeBuild entrypoint for projecting one configuration repository into the
# control-plane preset catalog. The checkout is data: no script from it is
# executed. Exact commits make every visible preset traceable to Git.

set -Eeuo pipefail

for variable in CONFIG_COMMIT RELEASE_BUCKET CONFIG_REPOSITORY_URL; do
  [[ -n "${!variable:-}" && "${!variable}" != "REQUIRED_BY_CALLER" ]] || {
    printf 'error: %s is required\n' "${variable}" >&2
    exit 1
  }
done

[[ "${CONFIG_COMMIT}" =~ ^[0-9a-f]{40}$ ]] || {
  printf 'error: CONFIG_COMMIT must be a full lowercase Git SHA\n' >&2
  exit 1
}

case "${CONFIG_REPOSITORY_URL}" in
  https://github.com/DrArzter/my-docker-minecraft-server-config | \
  https://github.com/DrArzter/my-docker-minecraft-server-config.git | \
  https://github.com/DrArzter/my-docker-factorio-server-config | \
  https://github.com/DrArzter/my-docker-factorio-server-config.git | \
  https://github.com/DrArzter/my-docker-zomboid-server-config | \
  https://github.com/DrArzter/my-docker-zomboid-server-config.git) ;;
  *)
    printf 'error: untrusted CONFIG_REPOSITORY_URL: %s\n' "${CONFIG_REPOSITORY_URL}" >&2
    exit 1
    ;;
esac

for command in awk aws find git jq sha256sum sort; do
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

checkout="${workspace}/config"
git init --quiet "${checkout}"
git -C "${checkout}" remote add origin "${CONFIG_REPOSITORY_URL}"
git -C "${checkout}" fetch --quiet --depth=1 origin "${CONFIG_COMMIT}"
git -C "${checkout}" checkout --quiet --detach FETCH_HEAD
[[ "$(git -C "${checkout}" rev-parse HEAD)" == "${CONFIG_COMMIT}" ]]

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
    '{id: $id, display_name: $display_name, profile_digest: $profile_digest, build_status: "unbuilt", latest_release: null}' \
    >>"${entries}"
done

catalog="${workspace}/catalog.json"
jq -s \
  --arg game "${game}" \
  --arg repository "${CONFIG_REPOSITORY_URL%.git}" \
  --arg commit "${CONFIG_COMMIT}" \
  '{schema_version: 1, game: $game, source: {repository: $repository, commit: $commit}, presets: .}' \
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
      if $previous then .build_status = $previous.build_status | .latest_release = $previous.latest_release else . end
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
printf 'config_commit=%s\n' "${CONFIG_COMMIT}"
printf 'presets=%s\n' "${#profiles[@]}"
printf 'catalog_key=%s\n' "${catalog_key}"
