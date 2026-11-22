#!/usr/bin/env bash

# Bring up the host's observability tier — one Prometheus and Grafana per host
# (ADR-0054, phase 9) — before a placed session starts, so its exporter has a
# network to join and something to scrape it. Safe to run for every session:
# `up -d` on a running project changes nothing.
#
# The network is created here, outside both projects, because the session's
# exporter and the tier each declare it external: a network owned by one
# project is taken down with that project, and the other would be left
# pointing at nothing. A tier that fails to come up is reported, not fatal —
# the game is what the session is for — but a network that cannot be created
# is, because the session's own Compose files name it.
#
# Output, key=value:
#   observability=ready|unavailable

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# SERVER_DIR, ENV_FILE and compose_env_file, as every other Compose call uses them.
# shellcheck source=_common.sh
source "${SCRIPT_DIR}/_common.sh"

readonly HOST_OBSERVABILITY_PROJECT="spawnpoint-observability"
readonly HOST_OBSERVABILITY_NETWORK="spawnpoint-observability"

if ! docker network inspect "${HOST_OBSERVABILITY_NETWORK}" >/dev/null 2>&1; then
  docker network create "${HOST_OBSERVABILITY_NETWORK}" >/dev/null
fi

args=(
  --project-name "${HOST_OBSERVABILITY_PROJECT}"
  --project-directory "${SERVER_DIR}"
  -f "${SERVER_DIR}/observability/compose.yaml"
  -f "${SERVER_DIR}/observability/compose.host.yaml"
)
# The escaped copy: a value with a dollar sign (the CurseForge key is
# bcrypt-shaped) reaches the containers whole, and no warning prints a piece of
# it into the session log.
if [[ -f "${ENV_FILE}" ]]; then
  args+=(--env-file "$(compose_env_file)")
fi

if docker compose "${args[@]}" up -d --quiet-pull >&2; then
  printf 'observability=ready\n'
else
  printf 'warning: the host observability tier did not come up; the session runs unscraped\n' >&2
  printf 'observability=unavailable\n'
fi
