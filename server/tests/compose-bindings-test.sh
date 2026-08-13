#!/usr/bin/env bash
set -euo pipefail

script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
server_directory="$(cd -- "${script_directory}/.." && pwd)"

rendered="$({
  CF_API_KEY=unused \
  RCON_PASSWORD=unused \
  GRAFANA_ADMIN_PASSWORD=unused \
  PROMETHEUS_BIND_ADDRESS=127.0.0.1 \
  GRAFANA_BIND_ADDRESS=0.0.0.0 \
    docker compose \
      --project-directory "${server_directory}" \
      -f "${server_directory}/compose.yaml" \
      -f "${server_directory}/compose.m0.yaml" \
      config --format json
} 2>/dev/null)"

jq -e '
  .services.prometheus.ports == [{
    "mode": "ingress",
    "target": 9090,
    "published": "9090",
    "host_ip": "127.0.0.1",
    "protocol": "tcp"
  }]
  and .services.grafana.ports == [{
    "mode": "ingress",
    "target": 3000,
    "published": "3000",
    "host_ip": "0.0.0.0",
    "protocol": "tcp"
  }]
  and (.services.mc.environment | has("CURSEFORGE_FILES") | not)
  and .services.mc.environment.REMOVE_OLD_MODS == "false"
' >/dev/null <<<"${rendered}"

printf 'result=passed\n'
