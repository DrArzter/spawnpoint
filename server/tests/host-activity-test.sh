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

# A docker stub speaking exactly the two shapes _common uses: `compose ... ps
# --all --quiet SERVICE` answers a fake id when a state is configured, and
# `inspect` answers that state.
cat >"${fixture}/bin/docker" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
args=("$@")
if [[ "${args[0]}" == "compose" ]]; then
  service="${args[$((${#args[@]} - 1))]}"
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

printf 'host-activity-test: ok\n'
