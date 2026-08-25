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
  CF_API_KEY=test-only
)

expect_failure "missing caller inputs" env -i PATH="${PATH}" "${builder}"
expect_failure "moving config ref" env "${base_env[@]}" CONFIG_COMMIT=main "${builder}"
expect_failure "unsafe profile id" env "${base_env[@]}" PROFILE_ID=../main "${builder}"
expect_failure "invalid release" env "${base_env[@]}" RELEASE=latest "${builder}"
expect_failure "untrusted config repository" env "${base_env[@]}" \
  CONFIG_REPOSITORY_URL=https://github.com/example/untrusted.git "${builder}"

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
printf 'resolved in aws builder test\n' >"${output}/mods/example-1.0.jar"
EOF
chmod 0755 "${fixture}/bin/docker"
ln -s -- "${repository_root}/server/tests/fake-aws" "${fixture}/bin/aws"

export FAKE_S3_ROOT="${fixture}/fake-s3"
builder_output="$(
  env \
    PATH="${fixture}/bin:${PATH}" \
    GIT_ALLOW_PROTOCOL=file \
    GIT_CONFIG_COUNT=1 \
    GIT_CONFIG_KEY_0="url.file://${config_repo}.insteadOf" \
    GIT_CONFIG_VALUE_0=https://github.com/DrArzter/my-docker-minecraft-server-config.git \
    CONFIG_COMMIT="${config_commit}" \
    PROFILE_ID=main \
    RELEASE=4.0 \
    RELEASE_BUCKET=spawnpoint-test-releases \
    CF_API_KEY=test-only \
    "${builder}"
)"
grep -qx 'result=release_ready' <<<"${builder_output}"
manifest="${FAKE_S3_ROOT}/spawnpoint-test-releases/releases/4.0/manifest.json"
jq -e \
  --arg commit "${config_commit}" \
  '.release == "4.0" and .source_profile.id == "main" and .source_profile.commit == $commit and (.server.mods | length) == 1' \
  "${manifest}" >/dev/null
[[ -f "${FAKE_S3_ROOT}/spawnpoint-test-releases/releases/4.0/mods/example-1.0.jar" ]]

printf 'result=passed\n'
