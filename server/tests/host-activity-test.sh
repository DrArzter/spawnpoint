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
if [[ "${args[0]}" == "ps" ]]; then
  service=""
  for arg in "${args[@]}"; do
    [[ "${arg}" != label=com.docker.compose.service=* ]] || service="${arg##*=}"
  done
  [[ -n "${service}" ]] || exit 64
  if [[ -f "${FAKE_STATES_DIR}/${service}" ]]; then
    printf 'fake-%s\n' "${service}"
  fi
  exit 0
fi
if [[ "${args[0]}" == "inspect" ]]; then
  id="${args[$((${#args[@]} - 1))]}"
  cat "${FAKE_STATES_DIR}/${id#fake-}"
  exit 0
fi
exit 64
STUB
chmod 0755 "${fixture}/bin/docker"

sensor="${REPOSITORY_ROOT}/server/scripts/check-host-activity.sh"

# Nothing runs anywhere: idle.
output="$("${sensor}")"
grep -qx 'other_active=0' <<<"${output}"
grep -qx 'host=idle' <<<"${output}"

# Factorio runs; minecraft asks "may the host sleep once I stop?" — no.
printf 'running\n' >"${FAKE_STATES_DIR}/factorio"
output="$("${sensor}" mc)"
grep -qx 'other_active=1' <<<"${output}"
grep -qx 'active_services=factorio' <<<"${output}"
grep -qx 'host=busy' <<<"${output}"

# The asking world's own service never counts against it.
output="$("${sensor}" factorio)"
grep -qx 'other_active=0' <<<"${output}"
grep -qx 'host=idle' <<<"${output}"

# An exited neighbour is not activity.
printf 'exited\n' >"${FAKE_STATES_DIR}/factorio"
output="$("${sensor}" mc)"
grep -qx 'host=idle' <<<"${output}"

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
printf 'running\n' >"${FAKE_STATES_DIR}/factorio"
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
