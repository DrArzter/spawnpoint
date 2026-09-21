#!/usr/bin/env bash

# The host-idle sensor: the seam between "this world is empty" and "the host
# may sleep". Stubbed docker, same technique as the compose tests.

set -Eeuo pipefail

REPOSITORY_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
fixture="$(mktemp -d /tmp/spawnpoint-host-activity-test.XXXXXXXX)"
cleanup() {
  rm -rf -- "${fixture}"
}
trap cleanup EXIT

mkdir -p -- "${fixture}/bin"
export PATH="${fixture}/bin:${PATH}"
export FAKE_STATES_DIR="${fixture}/states"
mkdir -p -- "${FAKE_STATES_DIR}"

# The host sensor inspects Compose labels directly, so missing secrets for an
# inactive game's Compose file can never make the whole host unknowable.
cat >"${fixture}/bin/docker" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
args=("$@")
# A fake container is a file <service> or <service>@<project> holding its
# state; the second form is a placed session's own Compose project (ADR-0054).
if [[ "${args[0]}" == "ps" ]]; then
  service=""
  for arg in "${args[@]}"; do
    [[ "${arg}" != label=com.docker.compose.service=* ]] || service="${arg##*=}"
  done
  [[ -n "${service}" ]] || exit 64
  for state_file in "${FAKE_STATES_DIR}/${service}" "${FAKE_STATES_DIR}/${service}@"*; do
    [[ -f "${state_file}" ]] && printf 'fake-%s\n' "$(basename -- "${state_file}")"
  done
  exit 0
fi
if [[ "${args[0]}" == "inspect" ]]; then
  id="${args[$((${#args[@]} - 1))]}"
  name="${id#fake-}"
  project=""
  [[ "${name}" != *@* ]] || project="${name#*@}"
  printf '%s %s\n' "$(cat "${FAKE_STATES_DIR}/${name}")" "${project}"
  exit 0
fi
exit 64
STUB
chmod 0755 "${fixture}/bin/docker"

sensor="${REPOSITORY_ROOT}/server/scripts/check-host-activity.sh"
readonly RUNNING_STATE='running'
readonly HOST_IDLE='host=idle'

# Nothing runs anywhere: idle.
output="$("${sensor}")"
grep -qx 'other_active=0' <<<"${output}"
grep -qx "${HOST_IDLE}" <<<"${output}"

# Factorio runs; minecraft asks "may the host sleep once I stop?" — no.
printf '%s\n' "${RUNNING_STATE}" >"${FAKE_STATES_DIR}/factorio"
output="$("${sensor}" mc)"
grep -qx 'other_active=1' <<<"${output}"
grep -qx 'active_services=factorio' <<<"${output}"
grep -qx 'host=busy' <<<"${output}"

# The asking world's own service never counts against it.
output="$("${sensor}" factorio)"
grep -qx 'other_active=0' <<<"${output}"
grep -qx "${HOST_IDLE}" <<<"${output}"

# An exited neighbour is not activity.
printf 'exited\n' >"${FAKE_STATES_DIR}/factorio"
output="$("${sensor}" mc)"
grep -qx "${HOST_IDLE}" <<<"${output}"
rm -f -- "${FAKE_STATES_DIR}/factorio"

# --- placed sessions (ADR-0054): the asking session is its project and its
#     service; the same game in another project is a neighbour ---
printf '%s\n' "${RUNNING_STATE}" >"${FAKE_STATES_DIR}/mc@spawnpoint-vanilla"
output="$(SERVER_COMPOSE_PROJECT=spawnpoint-world "${sensor}" mc)"
grep -qx 'other_active=1' <<<"${output}"
grep -qx 'active_services=mc' <<<"${output}"
grep -qx 'active_projects=spawnpoint-vanilla' <<<"${output}"
grep -qx 'host=busy' <<<"${output}"
output="$(SERVER_COMPOSE_PROJECT=spawnpoint-vanilla "${sensor}" mc)"
grep -qx 'other_active=0' <<<"${output}"
grep -qx "${HOST_IDLE}" <<<"${output}"
# An unplaced session in the default project asking beside a placed one.
output="$("${sensor}" mc)"
grep -qx 'host=busy' <<<"${output}"
# Two projects, two games, one leaving: the other keeps the host awake.
printf '%s\n' "${RUNNING_STATE}" >"${FAKE_STATES_DIR}/factorio@spawnpoint-base"
output="$(SERVER_COMPOSE_PROJECT=spawnpoint-vanilla "${sensor}" mc)"
grep -qx 'other_active=1' <<<"${output}"
grep -qx 'active_projects=spawnpoint-base' <<<"${output}"
rm -f -- "${FAKE_STATES_DIR}/mc@spawnpoint-vanilla" "${FAKE_STATES_DIR}/factorio@spawnpoint-base"

# --- the gate as the stop path sees it: an exit code, not a line to parse.
#     stop-session runs the real gate at the end, so its code carries the
#     answer to "may this host sleep?" ---
gate_exit() {
  local asking="$1"
  local code=0
  "${sensor}" "${asking}" >/dev/null 2>&1 || code=$?
  printf '%s' "${code}"
}

# A readable host answers with 0 whoever asks; the answer itself is the host=
# line, and only an unreadable sensor is a non-zero exit (fail closed).
printf '%s\n' "${RUNNING_STATE}" >"${FAKE_STATES_DIR}/factorio"
[[ "$(gate_exit mc)" == "0" ]]
[[ "$(gate_exit factorio)" == "0" ]]
rm -f -- "${FAKE_STATES_DIR}/factorio"

# A sensor that cannot inspect a container refuses rather than reporting idle.
cat >"${fixture}/bin/docker" <<'BROKEN'
#!/usr/bin/env bash
exit 1
BROKEN
chmod 0755 "${fixture}/bin/docker"
[[ "$(gate_exit mc)" == "2" ]]

printf 'host-activity-test: ok\n'
