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
    PALWORLD_ADMIN_PASSWORD="${PALWORLD_ADMIN_PASSWORD-unused}" \
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

# The gate follows the world: start-session.sh answers FALSE for a world that
# keeps no names, and a session rendered outside it keeps the gate. An empty
# list with the gate on is a server nobody can join.
ungated="$(SPAWNPOINT_WHITELIST_ENABLED=FALSE render_game minecraft 2>/dev/null)"
jq -e '
  .services.mc.environment.ENABLE_WHITELIST == "FALSE"
  and .services.mc.environment.ENFORCE_WHITELIST == "FALSE"
' >/dev/null <<<"${ungated}"

# The server's level folder is the one the backup contract archives. It is
# pinned, never the image's default and never a world's id.
level_name="$(
  # shellcheck source=../games/minecraft/game.sh
  source "${server_directory}/games/minecraft/game.sh"
  printf '%s' "${MINECRAFT_LEVEL_NAME}"
)"
jq -e --arg level "${level_name}" '.services.mc.environment.LEVEL == $level' >/dev/null <<<"${rendered}"

# Every game setting (ADR-0064) has its entry. One the world does not set has
# no value, so the container never sees it and the server keeps what it had;
# difficulty keeps the default it always had.
jq -e --slurpfile definitions "${server_directory}/games/minecraft/settings.json" '
  .services.mc.environment as $environment
  | all($definitions[0].settings[]; .env as $name | $environment | has($name))
  and $environment.DIFFICULTY == "normal"
  and all($definitions[0].settings[] | select(.env != "DIFFICULTY"); .env as $name | $environment[$name] == null)
' >/dev/null <<<"${rendered}"
set_rendered="$(DIFFICULTY=hard MAX_PLAYERS=8 MOTD="Rostik's world" render_game minecraft 2>/dev/null)"
jq -e '
  .services.mc.environment.DIFFICULTY == "hard" and .services.mc.environment.MAX_PLAYERS == "8"
  and .services.mc.environment.MOTD == "Rostik'"'"'s world" and .services.mc.environment.MODE == null
' >/dev/null <<<"${set_rendered}"

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

# The release is reconciled into the world's mods directory, beside its data;
# the game must read that directory, or a modded world runs without its mods.
factorio_world_rendered="$(
  SPAWNPOINT_WORLD_DATA_DIRECTORY=/srv/worlds/f/generations/g/data \
  SPAWNPOINT_WORLD_MODS_DIRECTORY=/srv/worlds/f/generations/g/mods \
    render_game factorio 2>/dev/null
)"
jq -e '
  [.services.factorio.volumes[] | select(.type == "bind") | {source, target}]
  == [{source: "/srv/worlds/f/generations/g/data", target: "/factorio"},
      {source: "/srv/worlds/f/generations/g/mods", target: "/factorio/mods"}]
' >/dev/null <<<"${factorio_world_rendered}"

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

# Valheim: the image pinned by digest, the query port host-local, the save's
# name the one game.sh archives, unlisted and without crossplay, and every
# game setting an entry with no value.
valheim_world_name="$(
  # shellcheck source=../games/valheim/game.sh
  source "${server_directory}/games/valheim/game.sh"
  printf '%s' "${VALHEIM_WORLD_NAME}"
)"
valheim_rendered="$(render_game valheim 2>/dev/null)"
jq -e '
  (.services.valheim.image | test("^[a-z0-9./-]+@sha256:[0-9a-f]{64}$"))
  and ([.services.valheim.ports[] | select(.target == 2456)] | .[0].published == "2456" and .[0].protocol == "udp" and .[0].host_ip == "0.0.0.0")
  and ([.services.valheim.ports[] | select(.target == 2457)] | .[0].published == "2457" and .[0].protocol == "udp" and .[0].host_ip == "127.0.0.1")
  and (.services.valheim.ports | length == 2)
' >/dev/null <<<"${valheim_rendered}"
jq -e --arg world "${valheim_world_name}" --slurpfile definitions "${server_directory}/games/valheim/settings.json" '
  .services.valheim.environment as $environment
  | $environment.WORLD_NAME == $world
  and $environment.SERVER_PUBLIC == "false" and $environment.CROSSPLAY == "false" and $environment.SERVER_ARGS == ""
  and $environment.UPDATE_CRON == "" and $environment.RESTART_CRON == "" and $environment.BACKUPS == "false"
  and $environment.SERVER_PASS == ""
  and all($definitions[0].settings[]; .env as $name | ($environment | has($name)) and $environment[$name] == null)
' >/dev/null <<<"${valheim_rendered}"
jq -e '.services.valheim.environment.SERVER_NAME == "Long ships" and .services.valheim.environment.SERVER_PASS == "unused-pass"' \
  >/dev/null <<<"$(SERVER_NAME="Long ships" VALHEIM_SERVER_PASSWORD=unused-pass render_game valheim 2>/dev/null)"
valheim_slot="$(WORLD_ID=longships WORLD_FOOTPRINT_MEMORY_MIB=4096 SPAWNPOINT_SLOT=1 render_game valheim 2>/dev/null)"
jq -e '
  ([.services.valheim.ports[] | select(.target == 2456)] | .[0].published == "30010" and .[0].protocol == "udp")
  and ([.services.valheim.ports[] | select(.target == 2457)] | .[0].published == "30011" and .[0].host_ip == "127.0.0.1")
  and (((.services.valheim.mem_limit // .services.valheim.deploy.resources.limits.memory) | tostring | tonumber) == 4096 * 1024 * 1024)
' >/dev/null <<<"${valheim_slot}"

# Palworld: the image pinned by digest, the REST API host-local (its maker
# says it must not face the Internet), the admin password from the host .env,
# RCON off, unlisted and Steam only, nothing that downloads or copies behind
# our back, and every game setting an entry with no value.
palworld_rendered="$(render_game palworld 2>/dev/null)"
jq -e '
  (.services.palworld.image | test("^[a-z0-9./-]+@sha256:[0-9a-f]{64}$"))
  and ([.services.palworld.ports[] | select(.target == 8211)] | .[0].published == "8211" and .[0].protocol == "udp" and .[0].host_ip == "0.0.0.0")
  and ([.services.palworld.ports[] | select(.target == 8212)] | .[0].published == "8212" and .[0].protocol == "tcp" and .[0].host_ip == "127.0.0.1")
  and (.services.palworld.ports | length == 2)
  and ([.services.palworld.volumes[] | select(.target == "/palworld/Pal/Saved")] | length == 1)
' >/dev/null <<<"${palworld_rendered}"
jq -e --slurpfile definitions "${server_directory}/games/palworld/settings.json" '
  .services.palworld.environment as $environment
  | $environment.ADMIN_PASSWORD == "unused" and $environment.SERVER_PASSWORD == ""
  and $environment.REST_API_ENABLED == "true" and $environment.REST_API_PORT == "8212"
  and $environment.RCON_ENABLED == "false" and $environment.COMMUNITY == "false"
  and $environment.CROSSPLAY_PLATFORMS == "(Steam)" and $environment.PUBLIC_PORT == "8211"
  and $environment.AUTO_UPDATE_ENABLED == "false" and $environment.AUTO_REBOOT_ENABLED == "false"
  and $environment.AUTO_PAUSE_ENABLED == "false" and $environment.BACKUP_ENABLED == "false"
  and $environment.USE_BACKUP_SAVE_DATA == "False"
  and $environment.MOD_ENABLED == "false" and $environment.MOD_UPDATE_ON_BOOT == "false"
  and $environment.ENABLE_PLAYER_LOGGING == "false"
  and all($definitions[0].settings[]; .env as $name | ($environment | has($name)) and $environment[$name] == null)
' >/dev/null <<<"${palworld_rendered}"
jq -e '.services.palworld.environment.SERVER_NAME == "Pal camp" and .services.palworld.environment.PLAYERS == "8" and .services.palworld.environment.SERVER_PASSWORD == "unused-pass"' \
  >/dev/null <<<"$(SERVER_NAME="Pal camp" PLAYERS=8 PALWORLD_SERVER_PASSWORD=unused-pass render_game palworld 2>/dev/null)"
# Without the admin password the session does not render at all.
if PALWORLD_ADMIN_PASSWORD="" render_game palworld >/dev/null 2>&1; then exit 1; fi
palworld_slot="$(WORLD_ID=palcamp WORLD_FOOTPRINT_MEMORY_MIB=16384 SPAWNPOINT_SLOT=1 render_game palworld 2>/dev/null)"
jq -e '
  ([.services.palworld.ports[] | select(.target == 8211)] | .[0].published == "30010" and .[0].protocol == "udp")
  and ([.services.palworld.ports[] | select(.target == 8212)] | .[0].published == "30011" and .[0].host_ip == "127.0.0.1")
  and .services.palworld.environment.PUBLIC_PORT == "30010"
  and (((.services.palworld.mem_limit // .services.palworld.deploy.resources.limits.memory) | tostring | tonumber) == 16384 * 1024 * 1024)
' >/dev/null <<<"${palworld_slot}"

# ADR-0085: the persistent host opens every game module's own port and the
# slot range to the internet. That is safe only while each port the host opens
# listens on loopback or on the session's bind address: a ZeroTier world binds
# its game ports to the overlay address alone. A new or changed game module
# that publishes on every address fails here, not on the internet.
overlay_address="10.147.17.5"
opened_port() {
  local port="$1"
  (( port >= 30010 && port <= 32559 )) && return 0
  local module
  for module in "${server_directory}"/games/*/game.sh; do
    [[ "$(sed -nE 's/^GAME_CONNECT_PORT="([0-9]+)".*/\1/p' "${module}")" == "${port}" ]] && return 0
  done
  return 1
}
for module in "${server_directory}"/games/*/game.sh; do
  game="$(basename "$(dirname "${module}")")"
  slots=("")
  # A game whose server names its own ports to clients never runs in a slot.
  grep -q '^GAME_SLOTTABLE="\{0,1\}false' "${module}" || slots+=(7)
  for slot in "${slots[@]}"; do
    # A placed session carries its footprint; an unplaced one does not need it.
    bound="$(WORLD_ID=bindcheck WORLD_FOOTPRINT_MEMORY_MIB=4096 SPAWNPOINT_SLOT="${slot}" SPAWNPOINT_GAME_BIND="${overlay_address}" render_game "${game}" 2>/dev/null || true)"
    [[ -n "${bound}" ]] || { printf 'FAIL: %s did not render for the binding check\n' "${game}" >&2; exit 1; }
    while IFS=$'\t' read -r port address; do
      opened_port "${port}" || continue
      [[ "${address}" == "127.0.0.1" || "${address}" == "${overlay_address}" ]] || {
        printf 'FAIL: %s (slot %s) publishes opened port %s on %s, not on loopback or the session address\n' "${game}" "${slot:-none}" "${port}" "${address:-every address}" >&2
        exit 1
      }
    done < <(jq -r '.services[] | (.ports // [])[] | [.published, (.host_ip // "")] | @tsv' <<<"${bound}")
    # The game's own port is on the session's address, never left to the default.
    jq -e --arg address "${overlay_address}" '[.services[] | (.ports // [])[] | select(.host_ip == $address)] | length > 0' >/dev/null <<<"${bound}" || {
      printf 'FAIL: %s (slot %s) does not publish its game port on the session address\n' "${game}" "${slot:-none}" >&2
      exit 1
    }
  done
done

printf 'result=passed\n'
