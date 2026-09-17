#!/usr/bin/env bash
set -euo pipefail

script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
server_directory="$(cd -- "${script_directory}/.." && pwd)"

# The file list is the game module's own, so the test renders what a session
# actually runs rather than a hand-kept copy of it.
# The dispatcher assembles the file list a session actually runs, with or
# without a slot, so the test renders exactly that rather than a hand-kept copy.
render_game() {
  local game="$1"
  (
    # shellcheck source=../games/_dispatch.sh
    source "${server_directory}/games/_dispatch.sh"
    load_game "${game}"
    configure_game_compose
    local files=()
    local absolute
    IFS=':' read -r -a files <<<"${SERVER_COMPOSE_FILES}"
    local args=(--project-directory "${server_directory}")
    for absolute in "${files[@]}"; do
      args+=(-f "${absolute}")
    done
    CF_API_KEY=unused \
    RCON_PASSWORD=unused \
    ZOMBOID_RCON_PASSWORD=unused \
    ZOMBOID_ADMIN_PASSWORD=unused \
    SPAWNPOINT_GAME_IMAGE=registry.example.invalid/factorio:9.9.9@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
    GRAFANA_ADMIN_PASSWORD=unused \
    PROMETHEUS_BIND_ADDRESS=127.0.0.1 \
    GRAFANA_BIND_ADDRESS=0.0.0.0 \
      docker compose "${args[@]}" config --format json
  )
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

# --- a placed session (ADR-0054) ---
# Slot zero keeps the game's ports and takes the footprint's limit. Every placed
# session runs without a tier of its own: its exporter carries the labels the
# host tier discovers it by and joins the network it is scraped over.
scraped_by_host='
  (.services | has("prometheus") | not) and (.services | has("grafana") | not)
  and (.services | has("node-exporter") | not) and (.services | has("cadvisor") | not)
  and (.services | has("minecraft-exporter"))
  and .services["minecraft-exporter"].labels["spawnpoint.scrape"] == "true"
  and .services["minecraft-exporter"].labels["spawnpoint.scrape_port"] == "8080"
  and .services["minecraft-exporter"].labels["spawnpoint.scrape_job"] == "minecraft"
  and (.services["minecraft-exporter"].networks | has("spawnpoint-observability"))
  and (.services["minecraft-exporter"].networks | has("default"))
  and .networks["spawnpoint-observability"].external == true
  and .networks["spawnpoint-observability"].name == "spawnpoint-observability"
'
zero_rendered="$(WORLD_ID=world WORLD_FOOTPRINT_MEMORY_MIB=7168 SPAWNPOINT_SLOT=0 render_game minecraft 2>/dev/null)"
jq -e "${scraped_by_host}"' 
  and (.services.mc.ports[0].published == "25565")
  and (((.services.mc.mem_limit // .services.mc.deploy.resources.limits.memory) | tostring | tonumber) == 7168 * 1024 * 1024)
' >/dev/null <<<"${zero_rendered}"
# Another slot publishes its window; the container's own port and everything
# else about the game are untouched.
second_rendered="$(WORLD_ID=magic WORLD_FOOTPRINT_MEMORY_MIB=7168 SPAWNPOINT_SLOT=2 render_game minecraft 2>/dev/null)"
jq -e "${scraped_by_host}"'
  and (.services | has("mc"))
  and (.services.mc.ports[0].published == "30020") and (.services.mc.ports[0].target == 25565)
  and .services.mc.environment.REMOVE_OLD_MODS == "false"
  and (((.services.mc.mem_limit // .services.mc.deploy.resources.limits.memory) | tostring | tonumber) == 7168 * 1024 * 1024)
' >/dev/null <<<"${second_rendered}"

# --- the host tier (ADR-0054, phase 9) ---
# One project per host: Prometheus reads the Docker socket to find every
# session's exporter, on the network the sessions join; Grafana carries every
# game's dashboards, because a host may run any of them.
host_tier="$(
  GRAFANA_ADMIN_PASSWORD=unused PROMETHEUS_BIND_ADDRESS=127.0.0.1 GRAFANA_BIND_ADDRESS=0.0.0.0 \
    docker compose --project-name spawnpoint-observability --project-directory "${server_directory}" \
      -f "${server_directory}/observability/compose.yaml" -f "${server_directory}/observability/compose.host.yaml" \
      config --format json 2>/dev/null
)"
jq -e '
  ([.services.prometheus.volumes[] | select(.target == "/etc/prometheus/prometheus.yml")] | length == 1
    and (.[0].source | endswith("/observability/prometheus.host.yml")))
  and ([.services.prometheus.volumes[] | select(.target == "/var/run/docker.sock")] | .[0].read_only == true)
  and .services.prometheus.user == "0"
  and (.services.prometheus.networks | has("spawnpoint-observability"))
  and .networks["spawnpoint-observability"].external == true
  and ([.services.grafana.volumes[].target] | index("/var/lib/grafana/dashboards/minecraft") != null)
  and ([.services.grafana.volumes[].target] | index("/var/lib/grafana/dashboards/shared") != null)
  and (.services.prometheus.ports[0].host_ip == "127.0.0.1")
  and (.services | has("mc") | not) and (.services | has("minecraft-exporter") | not)
' >/dev/null <<<"${host_tier}"
# The host configuration keeps the three static jobs and adds discovery that
# keeps only what opted in, on the one network it can reach.
grep -q "docker_sd_configs" "${server_directory}/observability/prometheus.host.yml"
grep -q "__meta_docker_container_label_spawnpoint_scrape\]" "${server_directory}/observability/prometheus.host.yml"
grep -q "regex: spawnpoint-observability" "${server_directory}/observability/prometheus.host.yml"
factorio_slot="$(WORLD_ID=base WORLD_FOOTPRINT_MEMORY_MIB=2048 SPAWNPOINT_SLOT=1 render_game factorio 2>/dev/null)"
jq -e '
  ([.services.factorio.ports[] | select(.target == 34197)] | .[0].published == "30010" and .[0].protocol == "udp")
  and ([.services.factorio.ports[] | select(.target == 27015)] | .[0].published == "30011" and .[0].host_ip == "127.0.0.1")
  and (((.services.factorio.mem_limit // .services.factorio.deploy.resources.limits.memory) | tostring | tonumber) == 2048 * 1024 * 1024)
' >/dev/null <<<"${factorio_slot}"

printf 'result=passed\n'
