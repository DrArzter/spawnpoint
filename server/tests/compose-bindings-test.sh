#!/usr/bin/env bash
set -euo pipefail

script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
server_directory="$(cd -- "${script_directory}/.." && pwd)"

# The file list is the game module's own, so the test renders what a session
# actually runs rather than a hand-kept copy of it.
render_game() {
  local game="$1"
  local files=()
  local relative
  # shellcheck source=../games/_dispatch.sh
  source "${server_directory}/games/_dispatch.sh"
  load_game "${game}"
  IFS=':' read -r -a files <<<"${GAME_COMPOSE_FILES}"
  local args=(--project-directory "${server_directory}")
  for relative in "${files[@]}"; do
    args+=(-f "${server_directory}/${relative}")
  done
  CF_API_KEY=unused \
  RCON_PASSWORD=unused \
  SPAWNPOINT_GAME_IMAGE=registry.example.invalid/factorio:9.9.9@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
  GRAFANA_ADMIN_PASSWORD=unused \
  PROMETHEUS_BIND_ADDRESS=127.0.0.1 \
  GRAFANA_BIND_ADDRESS=0.0.0.0 \
    docker compose "${args[@]}" config --format json
}

rendered="$(render_game minecraft 2>/dev/null)"

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
  and .services.mc.environment.ENABLE_WHITELIST == "TRUE"
  and .services.mc.environment.ENFORCE_WHITELIST == "TRUE"
' >/dev/null <<<"${rendered}"

# The observability tier is shared, so it must appear in a session of a game
# that has no exporter of its own — and that game must not inherit another
# game's exporter or scrape file.
factorio_rendered="$(render_game factorio 2>/dev/null)"
jq -e '
  (.services | has("prometheus")) and (.services | has("grafana"))
  and (.services | has("node-exporter")) and (.services | has("cadvisor"))
  and (.services | has("factorio"))
  and .services.factorio.image == "registry.example.invalid/factorio:9.9.9@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  and (.services | has("minecraft-exporter") | not)
  and (.services | has("mc") | not)
  and ([.services.prometheus.volumes[].target] | index("/etc/prometheus/scrape/minecraft.yml") == null)
  and (.services.prometheus.ports == [{
    "mode": "ingress",
    "target": 9090,
    "published": "9090",
    "host_ip": "127.0.0.1",
    "protocol": "tcp"
  }])
' >/dev/null <<<"${factorio_rendered}"

# Minecraft keeps its own exporter, scrape job and dashboard; the shared tier
# carries only the host dashboards, so a factorio session shows no empty
# minecraft panels.
jq -e '
  (.services | has("minecraft-exporter"))
  and ([.services.prometheus.volumes[].target] | index("/etc/prometheus/scrape/minecraft.yml") != null)
  and (.services.prometheus.depends_on | has("minecraft-exporter"))
  and ([.services.grafana.volumes[].target] | index("/var/lib/grafana/dashboards/minecraft") != null)
' >/dev/null <<<"${rendered}"
jq -e '
  [.services.grafana.volumes[].target] | index("/var/lib/grafana/dashboards/minecraft") == null
' >/dev/null <<<"${factorio_rendered}"

printf 'result=passed\n'
