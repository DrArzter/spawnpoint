#!/usr/bin/env bash

# The host tier's bring-up (ADR-0054, phase 9): the network is created outside
# both projects, the tier is `up -d` under its own project name with the host
# overlay, and a tier that will not come up is reported rather than fatal.
# Stubbed docker records every call, the technique of compose-files-test.sh.

set -Eeuo pipefail

repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
server="${repository_root}/server"
fixture="$(mktemp -d /tmp/spawnpoint-host-observability-test.XXXXXXXX)"
cleanup() {
  rm -rf -- "${fixture}"
}
trap cleanup EXIT

mkdir -p -- "${fixture}/bin"
cat >"${fixture}/bin/docker" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"${FAKE_DOCKER_CALLS}"
case "$1 $2" in
  "network inspect") [[ -f "${FAKE_NETWORK_EXISTS}" ]] ;;
  "network create") : >"${FAKE_NETWORK_EXISTS}" ;;
  "compose "*) [[ -z "${FAKE_COMPOSE_FAILS:-}" ]] ;;
esac
EOF
chmod 0755 "${fixture}/bin/docker"
export PATH="${fixture}/bin:${PATH}"
export FAKE_DOCKER_CALLS="${fixture}/docker-calls"
export FAKE_NETWORK_EXISTS="${fixture}/network-exists"
export SERVER_PROJECT_DIRECTORY="${server}"
export SERVER_ENV_FILE="${fixture}/host.env"
printf 'GRAFANA_ADMIN_PASSWORD=unused\n' >"${SERVER_ENV_FILE}"

# --- first session on the host: create the network, bring the tier up ---
output="$("${server}/scripts/ensure-host-observability.sh" 2>"${fixture}/stderr")"
[[ "${output}" == "observability=ready" ]]
mapfile -t calls <"${FAKE_DOCKER_CALLS}"
[[ "${calls[0]}" == "network inspect spawnpoint-observability" ]]
[[ "${calls[1]}" == "network create spawnpoint-observability" ]]
[[ "${calls[2]}" == "compose --project-name spawnpoint-observability --project-directory ${server} -f ${server}/observability/compose.yaml -f ${server}/observability/compose.host.yaml --env-file ${SERVER_ENV_FILE} up -d --quiet-pull" ]]
[[ "${#calls[@]}" -eq 3 ]]

# --- every later session: the network exists, `up -d` is a no-op ---
: >"${FAKE_DOCKER_CALLS}"
output="$("${server}/scripts/ensure-host-observability.sh" 2>/dev/null)"
[[ "${output}" == "observability=ready" ]]
mapfile -t calls <"${FAKE_DOCKER_CALLS}"
[[ "${#calls[@]}" -eq 2 ]]
[[ "${calls[1]}" == compose* ]]

# --- a tier that will not come up is reported, and the session goes on ---
: >"${FAKE_DOCKER_CALLS}"
output="$(FAKE_COMPOSE_FAILS=1 "${server}/scripts/ensure-host-observability.sh" 2>"${fixture}/stderr")"
[[ "${output}" == "observability=unavailable" ]]
grep -q "did not come up" "${fixture}/stderr"

# --- no .env: the tier is asked without one, and Compose decides ---
: >"${FAKE_DOCKER_CALLS}"
SERVER_ENV_FILE="${fixture}/absent.env" "${server}/scripts/ensure-host-observability.sh" >/dev/null 2>&1
grep -Fvq -- "--env-file" "${FAKE_DOCKER_CALLS}"

printf 'result=passed\n'
