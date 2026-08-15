#!/usr/bin/env bash

set -Eeuo pipefail

repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
resolver="${repository_root}/server/scripts/resolve-profile-mods.sh"
fixture="$(mktemp -d /tmp/spawnpoint-profile-resolver-test.XXXXXXXX)"
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

config_repo="${fixture}/config"
mkdir -p -- \
  "${config_repo}/profiles/main/extras" \
  "${config_repo}/profiles/vanilla-forge" \
  "${config_repo}/profiles/escape" \
  "${fixture}/bin"
git -C "${config_repo}" init --quiet
git -C "${config_repo}" remote add origin https://github.com/example/minecraft-config.git
cat >"${config_repo}/profiles/main/profile.json" <<'EOF'
{"schema_version":1,"id":"main","minecraft_version":"1.20.1","loader":{"type":"forge","version":"47.4.10"},"mods":{"source":"extras/cf-mods.txt"}}
EOF
printf 'example-mod\n' >"${config_repo}/profiles/main/extras/cf-mods.txt"
cat >"${config_repo}/profiles/vanilla-forge/profile.json" <<'EOF'
{"schema_version":1,"id":"vanilla-forge","minecraft_version":"1.20.1","loader":{"type":"forge","version":"47.4.10"},"mods":{"source":null}}
EOF
cat >"${config_repo}/profiles/escape/profile.json" <<'EOF'
{"schema_version":1,"id":"escape","minecraft_version":"1.20.1","loader":{"type":"forge","version":"47.4.10"},"mods":{"source":"../../../outside.txt"}}
EOF
printf 'must not be mounted\n' >"${fixture}/outside.txt"
git -C "${config_repo}" add profiles
git -C "${config_repo}" -c user.name=Test -c user.email=test@example.invalid commit --quiet -m profiles

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
[[ -n "${output}" ]]
[[ "${CF_API_KEY:-}" == '$2a$10$test-only-not-a-secret' ]]
mkdir -p -- "${output}/mods"
printf 'resolved one\n' >"${output}/mods/one.jar"
printf 'resolved two\n' >"${output}/mods/two.jar"
EOF
chmod 0755 "${fixture}/bin/docker"

export PATH="${fixture}/bin:${PATH}"
printf "CF_API_KEY='\u00242a\u002410\u0024test-only-not-a-secret'\n" >"${fixture}/profile.env"
export PROFILE_ENV_FILE="${fixture}/profile.env"
unset CF_API_KEY

main_output="$("${resolver}" "${config_repo}/profiles/main" "${fixture}/main-output")"
grep -Fxq 'result=resolved' <<<"${main_output}"
grep -Fxq 'mods=2' <<<"${main_output}"
[[ -f "${fixture}/main-output/one.jar" ]]

vanilla_output="$("${resolver}" "${config_repo}/profiles/vanilla-forge" "${fixture}/vanilla-output")"
grep -Fxq 'mods=0' <<<"${vanilla_output}"
[[ -d "${fixture}/vanilla-output" ]]
[[ -z "$(find "${fixture}/vanilla-output" -mindepth 1 -print -quit)" ]]

expect_failure "immutable output is not overwritten" \
  "${resolver}" "${config_repo}/profiles/main" "${fixture}/main-output"
expect_failure "missing API key" \
  env -u CF_API_KEY -u PROFILE_ENV_FILE PATH="${PATH}" "${resolver}" \
    "${config_repo}/profiles/main" "${fixture}/missing-key"
expect_failure "mod source cannot escape profile directory" \
  "${resolver}" "${config_repo}/profiles/escape" "${fixture}/escaped-source"

printf 'dirty\n' >>"${config_repo}/profiles/main/extras/cf-mods.txt"
expect_failure "dirty source profile" \
  "${resolver}" "${config_repo}/profiles/main" "${fixture}/dirty-output"

printf 'result=passed\n'
