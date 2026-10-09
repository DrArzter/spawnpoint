#!/usr/bin/env bash

# A host brings its checkout to the deployed commit before a session starts
# (ADR-0067), only while no game runs on it, and never stops the start.

set -Eeuo pipefail

repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
fixture="$(mktemp -d /tmp/spawnpoint-update-checkout-test.XXXXXXXX)"
cleanup() {
  rm -rf -- "${fixture}"
}
trap cleanup EXIT

git_quiet() {
  git -c user.name=test -c user.email=test@example.invalid -c init.defaultBranch=main "$@" >/dev/null
  return 0
}

# --- an origin with three commits, each carrying the script under test ---
origin="${fixture}/origin"
mkdir -p -- "${origin}/server/scripts"
git_quiet init -q "${origin}"
git -C "${origin}" config uploadpack.allowReachableSHA1InWant true # as GitHub serves a commit by its id
cp -- "${repository_root}/server/scripts/update-checkout.sh" "${origin}/server/scripts/"
# The activity sensor needs docker; the test answers for it.
cat >"${origin}/server/scripts/check-host-activity.sh" <<'EOF'
#!/usr/bin/env bash
[[ "${FAKE_ACTIVITY:-idle}" != "unavailable" ]] || { printf 'result=unavailable\n'; exit 2; }
printf 'result=observed\nhost=%s\n' "${FAKE_ACTIVITY:-idle}"
EOF
chmod 0755 "${origin}/server/scripts/"*.sh
commits=()
for release in one two three; do
  printf '%s\n' "${release}" >"${origin}/server/release.txt"
  git_quiet -C "${origin}" add -A
  git_quiet -C "${origin}" commit -q -m "${release}"
  commits+=("$(git -C "${origin}" rev-parse HEAD)")
done
commit_one="${commits[0]}" commit_two="${commits[1]}" commit_three="${commits[2]}"

host="${fixture}/host"
git_quiet clone -q "file://${origin}" "${host}"
git_quiet -C "${host}" checkout -q --detach "${commit_one}"

# --- Parameter Store answers with whatever the test deployed ---
mkdir -p -- "${fixture}/bin"
cat >"${fixture}/bin/aws" <<'EOF'
#!/usr/bin/env bash
[[ "$1 $2" == "ssm get-parameter" ]] || exit 90
[[ "${FAKE_SSM_FAIL:-0}" != "1" ]] || exit 254
printf '%s\n' "${FAKE_DEPLOYED}"
EOF
chmod 0755 "${fixture}/bin/aws"

update() {
  env PATH="${fixture}/bin:${PATH}" AWS_REGION=eu-central-1 "$@" "${host}/server/scripts/update-checkout.sh"
}
expect() {
  local expected="$1" output
  shift
  output="$(update "$@")"
  grep -Fxq -- "${expected}" <<<"${output}" || {
    printf 'expected %s, got:\n%s\n' "${expected}" "${output}" >&2
    exit 1
  }
}
head_is() {
  [[ "$(git -C "${host}" rev-parse HEAD)" == "$1" ]] || {
    printf 'host is at %s, expected %s\n' "$(git -C "${host}" rev-parse HEAD)" "$1" >&2
    exit 1
  }
}

# --- an idle host moves to the deployed commit; what it keeps untracked stays ---
printf 'SECRET=kept\n' >"${host}/server/.env"
expect 'result=updated' FAKE_DEPLOYED="${commit_two}"
head_is "${commit_two}"
grep -Fxq two "${host}/server/release.txt"
grep -Fxq 'SECRET=kept' "${host}/server/.env"

# --- at the deployed commit already, nothing is fetched ---
expect 'result=current' FAKE_DEPLOYED="${commit_two}"

# --- a game running on the host keeps the checkout it started with ---
expect 'reason=sessions_running' FAKE_DEPLOYED="${commit_three}" FAKE_ACTIVITY=busy
expect 'reason=activity_unavailable' FAKE_DEPLOYED="${commit_three}" FAKE_ACTIVITY=unavailable
head_is "${commit_two}"

# --- an edit to a tracked file is not thrown away ---
printf 'edited by hand\n' >"${host}/server/release.txt"
expect 'reason=local_changes' FAKE_DEPLOYED="${commit_three}"
head_is "${commit_two}"
git -C "${host}" checkout -q -- server/release.txt

# --- Parameter Store unreadable, or a value git could read as an option ---
expect 'reason=parameter_unreadable' FAKE_DEPLOYED="${commit_three}" FAKE_SSM_FAIL=1
expect 'reason=parameter_invalid' FAKE_DEPLOYED='--upload-pack=touch /tmp/owned'
head_is "${commit_two}"

# --- a commit origin does not have leaves the host where it was ---
expect 'reason=fetch_failed' FAKE_DEPLOYED="$(printf 'f%.0s' {1..40})"
head_is "${commit_two}"

# --- the next deploy is taken once the host is idle again ---
expect 'result=updated' FAKE_DEPLOYED="${commit_three}"
head_is "${commit_three}"
grep -Fxq three "${host}/server/release.txt"

# --- a copy that is not a git checkout is left alone ---
plain="${fixture}/plain"
mkdir -p -- "${plain}/server/scripts"
cp -- "${host}/server/scripts/"*.sh "${plain}/server/scripts/"
output="$(env PATH="${fixture}/bin:${PATH}" AWS_REGION=eu-central-1 FAKE_DEPLOYED="${commit_one}" \
  GIT_CEILING_DIRECTORIES="${fixture}" "${plain}/server/scripts/update-checkout.sh")"
grep -Fxq 'reason=not_a_checkout' <<<"${output}"

printf 'update checkout test passed\n'
