#!/usr/bin/env bash

# The release plan: every class and section against the shared fixtures (the
# API's diff reads the same files), a first release, an older manifest without
# mod_index, the build log lines, and publication that never blocks a release.

set -Eeuo pipefail

repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
scripts="${repository_root}/server/scripts"
fixtures="${repository_root}/server/tests/fixtures/release-plan"
fixture="$(mktemp -d /tmp/spawnpoint-release-plan-test.XXXXXXXX)"
cleanup() {
  rm -rf -- "${fixture}"
}
trap cleanup EXIT

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

# name, new manifest, previous manifest or none
cases=(
  "modpack modpack-1.3.json modpack-1.2.json"
  "legacy modpack-1.3.json legacy-1.1.json"
  "first modpack-1.3.json none"
  "mod-set mod-set-2.1.json mod-set-2.0.json"
)
for case in "${cases[@]}"; do
  read -r name new previous <<<"${case}"
  [[ "${previous}" == none ]] || previous="${fixtures}/${previous}"
  RELEASE_PLAN_OUTPUT="${fixture}/${name}.json" \
    "${scripts}/plan-release.sh" "${fixtures}/${new}" "${previous}" >"${fixture}/${name}.log"
  [[ "$(jq -S . "${fixture}/${name}.json")" == "$(jq -S . "${fixtures}/plan-${name}.json")" ]] ||
    fail "plan ${name} differs from plan-${name}.json"
done

# The log of a compared release: counts, then removals before changes before additions.
log="${fixture}/modpack.log"
for line in plan=compared plan_previous_release=1.2 plan_matched_by=mod_id plan_release=1.3 \
  plan_mods_added=1 plan_mods_removed=1 plan_mods_changed=2 plan_mods_unchanged=4 \
  plan_overrides_added=1 plan_overrides_removed=1 plan_overrides_changed=1 \
  plan_client_mods_added=1 plan_client_mods_removed=0 plan_client_mods_changed=1 plan_client_pack_changed=true \
  'plan_loader={"type":"forge","version":"47.4.0"} -> {"type":"forge","version":"47.4.10"}'; do
  grep -qxF -- "${line}" "${log}" || fail "modpack log lacks ${line}"
done
! grep -q '^plan_minecraft=' "${log}" || fail "an unchanged Minecraft version is logged"
grep -qxF 'plan_minecraft="1.19.2" -> "1.20.1"' "${fixture}/legacy.log" || fail "legacy log lacks the Minecraft change"
grep -qx 'plan_matched_by=file_name' "${fixture}/legacy.log" || fail "legacy plan is not by file name"
[[ "$(grep '^plan_entry=' "${log}" | head -n 2)" == "plan_entry=removed server_mod oldmod-1.jar [oldmod]
plan_entry=changed server_mod create-0.5.jar [create] -> create-0.6.jar [create]" ]] || fail "entries are not in order"
[[ "$(grep -c '^plan_entry=' "${log}")" == 9 ]] || fail "modpack log has the wrong number of entries"

# At most the limit of named entries, and how many were left out.
RELEASE_PLAN_LOG_ENTRIES=2 RELEASE_PLAN_OUTPUT="${fixture}/limited.json" \
  "${scripts}/plan-release.sh" "${fixtures}/modpack-1.3.json" "${fixtures}/modpack-1.2.json" >"${fixture}/limited.log"
[[ "$(grep -c '^plan_entry=' "${fixture}/limited.log")" == 2 ]] || fail "the entry limit is not applied"
grep -qx 'plan_entries_omitted=7' "${fixture}/limited.log" || fail "omitted entries are not counted"

# A first release names no entries.
grep -qx 'plan=first_release' "${fixture}/first.log" || fail "first release is not said"
! grep -q '^plan_entry=' "${fixture}/first.log" || fail "a first release lists entries"

# Bad input fails, and leaves no plan behind.
printf '{"schema_version":2}\n' >"${fixture}/bad.json"
if RELEASE_PLAN_OUTPUT="${fixture}/bad-plan.json" \
  "${scripts}/plan-release.sh" "${fixtures}/modpack-1.3.json" "${fixture}/bad.json" >/dev/null 2>&1; then
  fail "a malformed previous manifest is accepted"
fi
[[ ! -e "${fixture}/bad-plan.json" ]] || fail "a failed plan left a file"
if "${scripts}/plan-release.sh" "${fixtures}/modpack-1.3.json" >/dev/null 2>&1; then
  fail "one argument is accepted"
fi

# --- publication: the plan goes after the payload and just before the
#     manifest; a plan that is wrong or fails to upload never stops a release ---
mkdir -p -- "${fixture}/payload/mods" "${fixture}/bin"
printf 'jar\n' >"${fixture}/payload/mods/example.jar"
manifest="${fixture}/payload/manifest.json"
RELEASE_LOADER_TYPE=fabric \
RELEASE_PROFILE_ID=planned \
RELEASE_PROFILE_REPOSITORY=https://github.com/example/config \
RELEASE_PROFILE_COMMIT=0123456789abcdef0123456789abcdef01234567 \
  "${scripts}/build-release-manifest.sh" 1.0 1.20.1 0.19.3 "${fixture}/payload/mods" "${manifest}" >/dev/null
RELEASE_PLAN_OUTPUT="${fixture}/plan.json" "${scripts}/plan-release.sh" "${manifest}" none >/dev/null

ln -s -- "${repository_root}/server/tests/fake-aws" "${fixture}/bin/aws"
export PATH="${fixture}/bin:${PATH}"
export RELEASE_BUCKET=spawnpoint-test-releases
export RELEASE_SOURCE_DIR="${fixture}/payload"
export FAKE_AWS_CALL_LOG="${fixture}/calls"
prefix=releases/minecraft/planned/1.0

publish() {
  local root="$1"
  shift
  FAKE_S3_ROOT="${fixture}/${root}" env "$@" "${scripts}/upload-release.sh" "${manifest}" 2>"${fixture}/${root}.stderr"
}

output="$(publish s3-ok RELEASE_PLAN="${fixture}/plan.json")"
grep -qx 'result=uploaded' <<<"${output}" || fail "release not uploaded"
grep -qx 'plan=uploaded' <<<"${output}" || fail "plan not uploaded"
grep -qx "plan_key=${prefix}/plan.json" <<<"${output}" || fail "plan key not printed"
cmp -s "${fixture}/plan.json" "${fixture}/s3-ok/${RELEASE_BUCKET}/${prefix}/plan.json" || fail "stored plan differs"
[[ "$(grep 'put-object' "${fixture}/calls" | grep -o -- '--key [^ ]*' | tail -n 3)" == "--key ${prefix}/client.zip
--key ${prefix}/plan.json
--key ${prefix}/manifest.json" ]] || fail "the plan is not put after the payload and just before the manifest"

# The same release again: the gate passes and the published plan stays.
output="$(publish s3-ok RELEASE_PLAN="${fixture}/plan.json")"
grep -qx 'result=already_present' <<<"${output}" || fail "rebuild not already_present"
grep -qx 'plan=skipped_existing_release' <<<"${output}" || fail "rebuild touched the plan"

# No plan from the caller: nothing is written.
output="$(publish s3-none)"
grep -qx 'plan=not_provided' <<<"${output}" || fail "a missing plan is not reported"
[[ ! -e "${fixture}/s3-none/${RELEASE_BUCKET}/${prefix}/plan.json" ]] || fail "a plan appeared from nowhere"

# A plan of another release, or a plan whose upload fails: the release publishes anyway.
jq '.release = "9.9"' "${fixture}/plan.json" >"${fixture}/other-plan.json"
output="$(publish s3-other RELEASE_PLAN="${fixture}/other-plan.json")"
grep -qx 'result=uploaded' <<<"${output}" || fail "a wrong plan blocked the release"
grep -qx 'plan=failed' <<<"${output}" || fail "a wrong plan is not reported"
[[ ! -e "${fixture}/s3-other/${RELEASE_BUCKET}/${prefix}/plan.json" ]] || fail "a wrong plan was stored"
[[ -f "${fixture}/s3-other/${RELEASE_BUCKET}/${prefix}/manifest.json" ]] || fail "manifest missing after a wrong plan"

output="$(publish s3-fail RELEASE_PLAN="${fixture}/plan.json" FAKE_S3_PUT_FAIL_KEY="${prefix}/plan.json")"
grep -qx 'result=uploaded' <<<"${output}" || fail "a failed plan upload blocked the release"
grep -qx 'plan=failed' <<<"${output}" || fail "a failed plan upload is not reported"
grep -q 'the release plan was not published' "${fixture}/s3-fail.stderr" || fail "no warning for a failed plan"
[[ -f "${fixture}/s3-fail/${RELEASE_BUCKET}/${prefix}/manifest.json" ]] || fail "manifest missing after a failed plan"

printf 'result=passed\n'
