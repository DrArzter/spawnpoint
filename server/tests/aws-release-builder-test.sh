#!/usr/bin/env bash

set -Eeuo pipefail

repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
builder="${repository_root}/scripts/aws-release-builder.sh"
fixture="$(mktemp -d /tmp/spawnpoint-aws-release-builder-test.XXXXXXXX)"
cleanup() {
  rm -rf -- "${fixture}"
}
trap cleanup EXIT

expect_failure() {
  local label="$1"
  shift
  if "$@" >/dev/null 2>&1; then
    printf 'expected failure: %s\n' "${label}" >&2
    exit 1
  fi
}

base_env=(
  CONFIG_COMMIT=0123456789abcdef0123456789abcdef01234567
  PROFILE_ID=main
  RELEASE=1.1
  RELEASE_BUCKET=spawnpoint-releases-123456789012
  CONFIG_REPOSITORY_URL=https://github.com/DrArzter/my-docker-minecraft-server-config.git
  CONFIG_SOURCE_KEY=config-sources/DrArzter/my-docker-minecraft-server-config/0123456789abcdef0123456789abcdef01234567.tar.gz
  CONFIG_SOURCE_SHA256=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
  CF_API_KEY=test-only
)

expect_failure "missing caller inputs" env -i PATH="${PATH}" "${builder}"
expect_failure "moving config ref" env "${base_env[@]}" CONFIG_COMMIT=main "${builder}"
expect_failure "unsafe profile id" env "${base_env[@]}" PROFILE_ID=../main "${builder}"
expect_failure "invalid release" env "${base_env[@]}" RELEASE=latest "${builder}"
expect_failure "untrusted config repository" env "${base_env[@]}" \
  CONFIG_REPOSITORY_URL=https://github.com/example/untrusted.git "${builder}"
expect_failure "unsupported preset source adapter" env "${base_env[@]}" \
  CONFIG_SOURCE_KIND=manual-upload "${builder}"
# With one authoring repository per game, an absent URL must refuse rather than
# silently pick a game.
expect_failure "no config repository named" \
  env CONFIG_COMMIT=0123456789abcdef0123456789abcdef01234567 PROFILE_ID=main RELEASE=1.1 \
  RELEASE_BUCKET=spawnpoint-releases-123456789012 CF_API_KEY=test-only "${builder}"

# Full orchestration without network, Docker or AWS: Git rewrites only the
# trusted public URL to a local fixture, while PATH adapters stand in for the
# pinned resolver container and S3 API. The production script itself is used.
config_repo="${fixture}/config"
mkdir -p -- "${config_repo}/profiles/main/extras" "${fixture}/bin"
git -C "${config_repo}" init --quiet
cat >"${config_repo}/profiles/main/profile.json" <<'EOF'
{"schema_version":1,"id":"main","minecraft_version":"1.20.1","loader":{"type":"forge","version":"47.4.10"},"mods":{"source":"extras/cf-mods.txt"}}
EOF
printf 'https://www.curseforge.com/minecraft/mc-mods/example\n' >"${config_repo}/profiles/main/extras/cf-mods.txt"
git -C "${config_repo}" add profiles
git -C "${config_repo}" -c user.name=Test -c user.email=test@example.invalid commit --quiet -m profile
config_commit="$(git -C "${config_repo}" rev-parse HEAD)"

cat >"${fixture}/bin/docker" <<'EOF'
#!/usr/bin/env bash
output=
previous=
for argument in "$@"; do
  if [[ "${previous}" == "--volume" && "${argument}" == *:/output ]]; then
    output="${argument%:/output}"
  fi
  previous="${argument}"
done
[[ -n "${output}" && -n "${CF_API_KEY:-}" ]]
mkdir -p -- "${output}/mods"
printf 'resolved in aws builder test%s\n' "${FAKE_JAR_VARIANT:-}" >"${output}/mods/example-1.0.jar"
EOF
chmod 0755 "${fixture}/bin/docker"
ln -s -- "${repository_root}/server/tests/fake-aws" "${fixture}/bin/aws"

export FAKE_S3_ROOT="${fixture}/fake-s3"
stage_config_source() {
  local repository="$1"
  local repository_slug="$2"
  local commit="$3"
  local archive="${fixture}/${commit}.tar.gz"
  local key="config-sources/${repository_slug}/${commit}.tar.gz"
  git -C "${repository}" archive --format=tar.gz --output="${archive}" "${commit}" profiles
  mkdir -p -- "${FAKE_S3_ROOT}/spawnpoint-test-releases/$(dirname -- "${key}")"
  cp -- "${archive}" "${FAKE_S3_ROOT}/spawnpoint-test-releases/${key}"
  printf '%s\t%s\n' "${key}" "$(sha256sum -- "${archive}" | awk '{print $1}')"
}
IFS=$'\t' read -r config_source_key config_source_sha256 < <(
  stage_config_source "${config_repo}" "DrArzter/my-docker-minecraft-server-config" "${config_commit}"
)
builder_output="$(
  env \
    PATH="${fixture}/bin:${PATH}" \
    CONFIG_REPOSITORY_URL=https://github.com/DrArzter/my-docker-minecraft-server-config.git \
    CONFIG_COMMIT="${config_commit}" \
    CONFIG_SOURCE_KEY="${config_source_key}" \
    CONFIG_SOURCE_SHA256="${config_source_sha256}" \
    PROFILE_ID=main \
    RELEASE=4.0 \
    RELEASE_BUCKET=spawnpoint-test-releases \
    CF_API_KEY=test-only \
    "${builder}" 2>"${fixture}/builder.err"
)"
grep -qx 'result=release_ready' <<<"${builder_output}"
grep -qx 'source_kind=github-snapshot' <<<"${builder_output}"
# Each step's duration reaches the build log, on stderr, without touching the result lines.
for step in config_snapshot resolve_mods build_release plan upload catalog; do
  grep -Eq "^timing step=${step} seconds=[0-9]+$" "${fixture}/builder.err"
done
if grep -q '^timing ' <<<"${builder_output}"; then
  printf 'timing lines must stay on stderr\n' >&2
  exit 1
fi
grep -qx "source_revision=${config_commit}" <<<"${builder_output}"
manifest="${FAKE_S3_ROOT}/spawnpoint-test-releases/releases/minecraft/main/4.0/manifest.json"
jq -e \
  --arg commit "${config_commit}" \
  '.release == "4.0" and .source_profile.id == "main" and .source_profile.commit == $commit and (.server.mods | length) == 1' \
  "${manifest}" >/dev/null
[[ -f "${FAKE_S3_ROOT}/spawnpoint-test-releases/releases/minecraft/main/4.0/mods/example-1.0.jar" ]]

# --- the plan: no catalog yet, so the first release; then the catalog's
#     latest_release, PREVIOUS_RELEASE, and a previous release that cannot be
#     read, which leaves the build as it was ---
grep -qx 'plan_catalog=unreadable' <<<"${builder_output}"
grep -qx 'plan=first_release' <<<"${builder_output}"
grep -qx 'plan=uploaded' <<<"${builder_output}"
releases_root="${FAKE_S3_ROOT}/spawnpoint-test-releases/releases/minecraft/main"
jq -e '.release == "4.0" and .previous_release == null and (.server_mods.added | length) == 1' \
  "${releases_root}/4.0/plan.json" >/dev/null
mkdir -p -- "${FAKE_S3_ROOT}/spawnpoint-test-releases/presets/minecraft"
printf '{"schema_version":2,"presets":[{"id":"other","latest_release":"9.9"},{"id":"main","latest_release":"4.0"}]}\n' \
  >"${FAKE_S3_ROOT}/spawnpoint-test-releases/presets/minecraft/catalog.json"
build_main() {
  env \
    PATH="${fixture}/bin:${PATH}" \
    CONFIG_REPOSITORY_URL=https://github.com/DrArzter/my-docker-minecraft-server-config.git \
    CONFIG_COMMIT="${config_commit}" \
    CONFIG_SOURCE_KEY="${config_source_key}" \
    CONFIG_SOURCE_SHA256="${config_source_sha256}" \
    PROFILE_ID=main \
    RELEASE_BUCKET=spawnpoint-test-releases \
    CF_API_KEY=test-only \
    FAKE_AWS_CALL_LOG="${fixture}/plan-calls" \
    "$@" \
    "${builder}"
}
plan_output="$(build_main RELEASE=4.1 FAKE_JAR_VARIANT=-4.1)"
grep -qx 'result=release_ready' <<<"${plan_output}"
grep -qx 'plan=compared' <<<"${plan_output}"
grep -qx 'plan_previous_release=4.0' <<<"${plan_output}"
grep -qx 'plan_mods_changed=1' <<<"${plan_output}"
grep -qx 'plan_entry=changed server_mod example-1.0.jar -> example-1.0.jar' <<<"${plan_output}"
grep -qx 'plan_key=releases/minecraft/main/4.1/plan.json' <<<"${plan_output}"
jq -e '.previous_release == "4.0" and (.server_mods.changed | length) == 1' "${releases_root}/4.1/plan.json" >/dev/null
# The plan is the last put before the manifest.
puts="$(grep 'put-object' "${fixture}/plan-calls" | grep -o -- '--key [^ ]*' | tail -n 2)"
[[ "${puts}" == $'--key releases/minecraft/main/4.1/plan.json\n--key releases/minecraft/main/4.1/manifest.json' ]]

plan_output="$(build_main RELEASE=4.2 PREVIOUS_RELEASE=none)"
grep -qx 'plan=first_release' <<<"${plan_output}"
jq -e '.previous_release == null' "${releases_root}/4.2/plan.json" >/dev/null

plan_output="$(build_main RELEASE=4.3 PREVIOUS_RELEASE=3.9)"
grep -qx 'result=release_ready' <<<"${plan_output}"
grep -qx 'plan_reason=previous_manifest_unreadable' <<<"${plan_output}"
grep -qx 'plan=not_provided' <<<"${plan_output}"
[[ -f "${releases_root}/4.3/manifest.json" && ! -e "${releases_root}/4.3/plan.json" ]]

plan_output="$(build_main RELEASE=4.4 PREVIOUS_RELEASE=4.4)"
grep -qx 'plan_reason=same_release' <<<"${plan_output}"
grep -qx 'result=release_ready' <<<"${plan_output}"

# --- the bundle is self-contained: everything the packaged scripts reach for
#     is packaged too. A missing file here fails only in CodeBuild, where it is
#     most expensive to discover. ---
packaged="$(grep -oE 'filename = "[^"]+"' "${repository_root}/infra/terraform-releases/release-builder.tf" |
  sed -E 's/^filename = "(.*)"$/\1/')"
grep -Fxq 'scripts/config-sources/github-snapshot.sh' <<<"${packaged}" || {
  printf 'error: the release bundle does not package the enabled preset source adapter\n' >&2
  exit 1
}
while IFS= read -r entry; do
  [[ "${entry}" == *.sh && -f "${repository_root}/${entry}" ]] || continue
  while IFS= read -r reference; do
    case "${reference}" in
      server/* | scripts/*) ;;
      _*) reference="server/scripts/${reference}" ;;
      *) reference="server/${reference}" ;;
    esac
    grep -Fxq "${reference}" <<<"${packaged}" || {
      printf 'error: %s reaches for %s, which the release bundle does not package\n' "${entry}" "${reference}" >&2
      exit 1
    }
  done < <(grep -oE '\$\{(SERVER_SCRIPTS|server_scripts|repository_root)\}/[a-z0-9/_-]+\.sh|_[a-z0-9_]+\.sh|games/[a-z0-9-]+/[a-z0-9-]+\.sh' \
    "${repository_root}/${entry}" | sed -E 's#^\$\{(SERVER_SCRIPTS|server_scripts)\}/#server/scripts/#; s#^\$\{repository_root\}/##' | sort -u)
done <<<"${packaged}"

# --- the game axis: a factorio profile cuts through the same builder, with no
#     CurseForge key, no container, and its own authoring repository ---
factorio_config="${fixture}/factorio-config"
mkdir -p -- "${factorio_config}/profiles/factorio-vanilla/extras"
git -C "${factorio_config}" init --quiet
cat >"${factorio_config}/profiles/factorio-vanilla/profile.json" <<'EOF'
{"schema_version":1,"game":"factorio","id":"factorio-vanilla","display_name":"Factorio vanilla","factorio_version":"2.0.77","runtime":{"image":"registry.example.invalid/factorio:9.9.9@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},"loader":{"type":"factorio","version":null},"mods":{"source":"extras/mod-pins.txt"}}
EOF
printf 'graftorio2:0.4.20\n' >"${factorio_config}/profiles/factorio-vanilla/extras/mod-pins.txt"
git -C "${factorio_config}" add profiles
git -C "${factorio_config}" -c user.name=Test -c user.email=test@example.invalid commit --quiet -m profile
factorio_commit="$(git -C "${factorio_config}" rev-parse HEAD)"

ln -s -- "${repository_root}/server/tests/fake-curl" "${fixture}/bin/curl"
export FAKE_FACTORIO_ROOT="${fixture}/fake-portal"
mkdir -p -- "${FAKE_FACTORIO_ROOT}/blobs"
printf 'graftorio zip bytes\n' >"${FAKE_FACTORIO_ROOT}/blobs/graftorio2_0.4.20.zip"
blob_sha1="$(sha1sum -- "${FAKE_FACTORIO_ROOT}/blobs/graftorio2_0.4.20.zip" | awk '{print $1}')" # NOSONAR test fixture
jq -n \
  --arg sha1 "${blob_sha1}" \
  '{name: "graftorio2", releases: [{version: "0.4.20", file_name: "graftorio2_0.4.20.zip", sha1: $sha1,
     download_url: "/dl/graftorio2_0.4.20.zip",
     info_json: {factorio_version: "2.0", dependencies: ["base >= 2.0"]}}]}' \
  >"${FAKE_FACTORIO_ROOT}/mod-graftorio2.json"

factorio_url=https://github.com/DrArzter/my-docker-factorio-server-config.git
IFS=$'\t' read -r factorio_source_key factorio_source_sha256 < <(
  stage_config_source "${factorio_config}" "DrArzter/my-docker-factorio-server-config" "${factorio_commit}"
)
factorio_output="$(
  env \
    PATH="${fixture}/bin:${PATH}" \
    CONFIG_REPOSITORY_URL="${factorio_url}" \
    CONFIG_COMMIT="${factorio_commit}" \
    CONFIG_SOURCE_KEY="${factorio_source_key}" \
    CONFIG_SOURCE_SHA256="${factorio_source_sha256}" \
    PROFILE_ID=factorio-vanilla \
    RELEASE=5.0 \
    RELEASE_BUCKET=spawnpoint-test-releases \
    FAKE_FACTORIO_ROOT="${FAKE_FACTORIO_ROOT}" \
    FACTORIO_USERNAME=arzter \
    FACTORIO_TOKEN=portal-token \
    "${builder}"
)"
grep -qx 'result=release_ready' <<<"${factorio_output}"
grep -qx 'game=factorio' <<<"${factorio_output}"
factorio_manifest="${FAKE_S3_ROOT}/spawnpoint-test-releases/releases/factorio/factorio-vanilla/5.0/manifest.json"
jq -e '
  .game == "factorio"
  and .loader == {type: "factorio", version: "2.0.77"}
  and .runtime.image == "registry.example.invalid/factorio:9.9.9@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  and (.server.mods | length) == 1
' "${factorio_manifest}" >/dev/null
[[ -f "${FAKE_S3_ROOT}/spawnpoint-test-releases/releases/factorio/factorio-vanilla/5.0/mods/graftorio2_0.4.20.zip" ]]

# --- the catalog keeps its history: a success appends, it never replaces ---
# The preset catalog is published first. Release 5.0 was built before it, so
# the catalog finds it from its manifest, built from an unknown revision.
env \
  PATH="${fixture}/bin:${PATH}" \
  CONFIG_REPOSITORY_URL="${factorio_url}" \
  CONFIG_COMMIT="${factorio_commit}" \
  CONFIG_SOURCE_KEY="${factorio_source_key}" \
  CONFIG_SOURCE_SHA256="${factorio_source_sha256}" \
  RELEASE_BUCKET=spawnpoint-test-releases \
  "${repository_root}/scripts/aws-preset-catalog-builder.sh" >/dev/null
factorio_catalog="${FAKE_S3_ROOT}/spawnpoint-test-releases/presets/factorio/catalog.json"
jq -e '.presets[] | select(.id == "factorio-vanilla") | .build_status == "unbuilt" and .releases == ["5.0"] and .latest_release == "5.0"' \
  "${factorio_catalog}" >/dev/null
factorio_digest="$(jq -r '.presets[] | select(.id == "factorio-vanilla") | .profile_digest' "${factorio_catalog}")"
factorio_second="$(
  env \
    PATH="${fixture}/bin:${PATH}" \
    CONFIG_REPOSITORY_URL="${factorio_url}" \
    CONFIG_COMMIT="${factorio_commit}" \
    CONFIG_SOURCE_KEY="${factorio_source_key}" \
    CONFIG_SOURCE_SHA256="${factorio_source_sha256}" \
    PROFILE_ID=factorio-vanilla \
    RELEASE=5.1 \
    RELEASE_BUCKET=spawnpoint-test-releases \
    FAKE_FACTORIO_ROOT="${FAKE_FACTORIO_ROOT}" \
    FACTORIO_USERNAME=arzter \
    FACTORIO_TOKEN=portal-token \
    "${builder}"
)"
grep -qx 'preset_catalog=updated' <<<"${factorio_second}"
jq -e --arg digest "${factorio_digest}" --arg commit "${factorio_commit}" '
  .presets[] | select(.id == "factorio-vanilla")
  | .build_status == "ready" and .releases == ["5.0", "5.1"] and .latest_release == "5.1"
    and .built_from["5.0"].profile_digest == null
    and .built_from["5.1"] == {profile_digest: $digest, source_commit: $commit}
' "${factorio_catalog}" >/dev/null

# the CurseForge key is a minecraft requirement, enforced once the profile is
# known rather than for every game
if minecraft_without_key="$(
  env \
    PATH="${fixture}/bin:${PATH}" \
    CONFIG_REPOSITORY_URL=https://github.com/DrArzter/my-docker-minecraft-server-config.git \
    CONFIG_COMMIT="${config_commit}" \
    CONFIG_SOURCE_KEY="${config_source_key}" \
    CONFIG_SOURCE_SHA256="${config_source_sha256}" \
    PROFILE_ID=main \
    RELEASE=6.0 \
    RELEASE_BUCKET=spawnpoint-test-releases \
    "${builder}" 2>&1
)"; then
  printf 'expected failure: a minecraft profile without CF_API_KEY\n' >&2
  exit 1
fi
grep -q 'CF_API_KEY is required for a minecraft profile' <<<"${minecraft_without_key}"

printf 'result=passed\n'
