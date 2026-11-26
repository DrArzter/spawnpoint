#!/usr/bin/env bash

# The Spot watcher (ADR-0102) against a fake instance metadata service: no
# notice does nothing; a rebalance recommendation saves once per notice time;
# the two-minute notice announces, saves, flushes, announces again and reports
# one event, and never uploads. The session scripts it calls are fakes in a
# copy of the scripts directory that record their environment.

set -Eeuo pipefail

REPOSITORY_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
fixture="$(mktemp -d /tmp/spawnpoint-spot-watcher.XXXXXXXX)"
trap 'rm -rf -- "${fixture}"' EXIT

mkdir -p -- "${fixture}/server" "${fixture}/bin" "${fixture}/imds" "${fixture}/records"
cp -R -- "${REPOSITORY_ROOT}/server/scripts" "${fixture}/server/scripts"
scripts="${fixture}/server/scripts"
calls="${fixture}/calls"
: >"${calls}"

for fake in save-world.sh announce-world.sh; do
  cat >"${scripts}/${fake}" <<FAKE
#!/usr/bin/env bash
printf '%s world=%s slot=%s volume=%s catalog=%s args=%s\n' "${fake}" "\${WORLD_ID}" "\${SPAWNPOINT_SLOT}" \
  "\${SPAWNPOINT_SESSION_VOLUME_ID}" "\${SPAWNPOINT_WORLD_CATALOG}" "\$*" >>"${calls}"
[[ "\${WORLD_ID}" != "\${FAKE_FAIL_WORLD:-}" || "${fake}" != save-world.sh ]]
FAKE
done

# Fake IMDS: a token for PUT, a file per metadata path, curl -f's 22 when absent.
cat >"${fixture}/bin/curl" <<'FAKE'
#!/usr/bin/env bash
url="${@: -1}"
token=false
for arg in "$@"; do
  [[ "${arg}" == "X-aws-ec2-metadata-token: fake-token" ]] && token=true
  [[ "${arg}" == PUT ]] && { printf 'fake-token'; exit 0; }
done
[[ "${token}" == true ]] || exit 22
path="${url#*/latest/meta-data/}"
[[ -f "${FAKE_IMDS}/${path}" ]] || exit 22
cat "${FAKE_IMDS}/${path}"
FAKE
cat >"${fixture}/bin/aws" <<'FAKE'
#!/usr/bin/env bash
printf 'aws %s\n' "$*" >>"${FAKE_CALLS}"
[[ "$1 $2" == "events put-events" ]] || exit 1
printf '{"FailedEntryCount":0}\n'
FAKE
cat >"${fixture}/bin/sync" <<'FAKE'
#!/usr/bin/env bash
printf 'sync %s\n' "$*" >>"${FAKE_CALLS}"
FAKE
chmod +x "${fixture}"/bin/* "${scripts}"/*.sh

export PATH="${fixture}/bin:${PATH}"
export FAKE_IMDS="${fixture}/imds"
export FAKE_CALLS="${calls}"
export SPAWNPOINT_IMDS_URL=http://imds.invalid
export SPAWNPOINT_WATCH_ONCE=true
export SPAWNPOINT_SESSION_RECORDS_DIRECTORY="${fixture}/records"
export SPAWNPOINT_WORLDS_DIRECTORY="${fixture}/worlds"
export SERVER_ENV_FILE="${fixture}/env"
printf 'AWS_REGION=eu-central-1\nSPAWNPOINT_INSTANCE_ID=i-0123456789abcdef0\n' >"${SERVER_ENV_FILE}"
watcher="${scripts}/spot-watcher.sh"

# shellcheck source=../scripts/_session-records.sh
source "${scripts}/_session-records.sh"
write_session_record alpha 0 vol-0123456789abcdef0 /srv/catalog.json
write_session_record beta 3 vol-0fedcba9876543210 /srv/catalog.json
[[ "$(session_record_value "$(session_record_path beta)" slot)" == 3 ]]

# Nothing scheduled: no output, nothing called.
[[ -z "$("${watcher}")" ]]
[[ ! -s "${calls}" ]]

# A rebalance recommendation saves both sessions and nothing else.
mkdir -p -- "${fixture}/imds/events/recommendations" "${fixture}/imds/spot"
printf '{"noticeTime":"2026-11-26T12:00:00Z"}' >"${fixture}/imds/events/recommendations/rebalance"
output="$("${watcher}")"
grep -qx 'event=rebalance' <<<"${output}"
grep -qx 'kind=rebalance' <<<"${output}"
grep -qx 'saved=alpha,beta' <<<"${output}"
grep -qx 'reported=false' <<<"${output}"
[[ "$(grep -c '^save-world.sh' "${calls}")" == 2 ]]
grep -q '^save-world.sh world=beta slot=3 volume=vol-0fedcba9876543210 catalog=/srv/catalog.json' "${calls}"
if grep -q -e '^announce-world.sh' -e '^aws' -e '^sync' "${calls}"; then exit 1; fi

# The two-minute notice: announce, save, flush, announce, then one report.
: >"${calls}"
action_time="$(date -u -d '+120 seconds' +%Y-%m-%dT%H:%M:%SZ)"
printf '{"action":"terminate","time":"%s"}' "${action_time}" >"${fixture}/imds/spot/instance-action"
FAKE_FAIL_WORLD=beta "${watcher}" >"${fixture}/out" || true
output="$(cat "${fixture}/out")"
grep -qx 'event=notice' <<<"${output}"
grep -qx 'action=terminate' <<<"${output}"
grep -qx 'kind=notice' <<<"${output}"
grep -qx 'sessions=2' <<<"${output}"
grep -qx 'saved=alpha' <<<"${output}"
grep -qx 'failed=beta' <<<"${output}"
grep -qx 'reported=true' <<<"${output}"
diff -u <(cut -d' ' -f1,2 "${calls}" | grep -v '^aws') - <<'EXPECTED'
announce-world.sh world=alpha
save-world.sh world=alpha
sync -f
announce-world.sh world=alpha
announce-world.sh world=beta
save-world.sh world=beta
EXPECTED
grep -q "^announce-world.sh world=alpha .* args=This server moves to a new machine in about 2 minutes. Your world is being saved.$" "${calls}"
grep -q 'args=World saved. Reconnect to the same address in a few minutes.$' "${calls}"
grep -q "^sync -f -- ${fixture}/worlds/alpha$" "${calls}"
report="$(grep '^aws events put-events' "${calls}")"
[[ "$(grep -c '^aws' "${calls}")" == 1 ]]
if grep -q '^aws s3' "${calls}"; then exit 1; fi
entries="$(sed -E 's/.*--entries (.*) --output json$/\1/' <<<"${report}")"
jq -e --arg time "${action_time}" '
  length == 1 and .[0].Source == "spawnpoint.host" and .[0].DetailType == "Sessions saved for interruption" and
  (.[0].Detail | fromjson) == {instanceId: "i-0123456789abcdef0", actionTime: $time, saved: ["alpha"], failed: ["beta"]}
' <<<"${entries}" >/dev/null

# A record removed by unmount leaves nothing to save.
remove_session_record alpha
remove_session_record beta
output="$("${scripts}/save-for-interruption.sh" rebalance)"
grep -qx 'sessions=0' <<<"${output}"
grep -qx 'saved=' <<<"${output}"

printf 'spot watcher tests passed\n'
