#!/usr/bin/env bash

# The slot contract (ADR-0054), as the dispatcher hands it to the Compose
# helpers: which files a session runs, under which project name, on which
# ports, and what a slot refuses. Stubbed docker captures the arguments, the
# same technique as compose-files-test.sh.

set -Eeuo pipefail

repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
server="${repository_root}/server"
fixture="$(mktemp -d /tmp/spawnpoint-slot-contract-test.XXXXXXXX)"
cleanup() {
  rm -rf -- "${fixture}"
}
trap cleanup EXIT

mkdir -p -- "${fixture}/bin"
cat >"${fixture}/bin/docker" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$@" >"${FAKE_DOCKER_CAPTURE}"
EOF
chmod 0755 "${fixture}/bin/docker"
export PATH="${fixture}/bin:${PATH}"
export FAKE_DOCKER_CAPTURE="${fixture}/docker-arguments"
export SERVER_PROJECT_DIRECTORY="${server}"
export SERVER_ENV_FILE="${fixture}/missing.env"

# Each case is a subshell: the dispatcher exports its answers, and a case must
# not inherit another's.
files_for() {
  local game="$1"
  (
    # shellcheck source=../games/_dispatch.sh
    source "${server}/games/_dispatch.sh"
    load_game "${game}"
    configure_game_compose
    printf 'files=%s\n' "${SERVER_COMPOSE_FILES}"
    printf 'project=%s\n' "${SERVER_COMPOSE_PROJECT:-}"
    printf 'game_port=%s\n' "${SPAWNPOINT_GAME_PORT:-}"
    printf 'game_port_2=%s\n' "${SPAWNPOINT_GAME_PORT_2:-}"
    printf 'rcon_port=%s\n' "${SPAWNPOINT_RCON_PORT:-}"
    printf 'connect_port=%s\n' "${SPAWNPOINT_CONNECT_PORT:-}"
    printf 'footprint=%s\n' "${SPAWNPOINT_FOOTPRINT_MEMORY_MIB:-}"
    # shellcheck source=../scripts/_common.sh
    source "${server}/scripts/_common.sh"
    compose config --quiet
    printf 'docker=%s\n' "$(tr '\n' ' ' <"${FAKE_DOCKER_CAPTURE}")"
  )
}

expect_failure() {
  local label="$1"
  shift
  if "$@" >/dev/null 2>&1; then
    printf 'expected failure: %s\n' "${label}" >&2
    exit 1
  fi
}

# --- no slot: what ran before placement existed, byte for byte ---
unplaced="$(files_for minecraft)"
grep -Fxq "files=${server}/observability/compose.yaml:${server}/compose.yaml:${server}/compose.release.yaml:${server}/compose.minecraft-observability.yaml" <<<"${unplaced}"
grep -Fxq 'project=' <<<"${unplaced}"
grep -Fxq 'game_port=' <<<"${unplaced}"
grep -Fxq 'connect_port=' <<<"${unplaced}"
grep -Fxq 'footprint=' <<<"${unplaced}"
grep -Fq "docker=compose --project-directory ${server} -f " <<<"${unplaced}"
grep -Fvq -- '--project-name' <<<"${unplaced}"

# --- slot zero: the game's own ports and the observability tier, plus what
#     every placed session gets — a project of its own and its footprint's limit ---
zero="$(WORLD_ID=world WORLD_FOOTPRINT_MEMORY_MIB=7168 SPAWNPOINT_SLOT=0 files_for minecraft)"
grep -Fxq "files=${server}/observability/compose.yaml:${server}/compose.yaml:${server}/compose.release.yaml:${server}/compose.minecraft-observability.yaml:${server}/games/minecraft/compose.footprint.yaml" <<<"${zero}"
grep -Fxq 'project=spawnpoint-world' <<<"${zero}"
grep -Fxq 'game_port=25565' <<<"${zero}"
grep -Fxq 'rcon_port=25575' <<<"${zero}"
grep -Fxq 'game_port_2=' <<<"${zero}"
grep -Fxq 'connect_port=25565' <<<"${zero}"
grep -Fxq 'footprint=7168' <<<"${zero}"
grep -Fq -- '--project-name spawnpoint-world' <<<"${zero}"

# --- another slot: its window in the host-wide range, no observability tier ---
third="$(WORLD_ID=magic WORLD_FOOTPRINT_MEMORY_MIB=7168 SPAWNPOINT_SLOT=3 files_for minecraft)"
grep -Fxq "files=${server}/compose.yaml:${server}/compose.release.yaml:${server}/games/minecraft/compose.footprint.yaml" <<<"${third}"
grep -Fxq 'project=spawnpoint-magic' <<<"${third}"
grep -Fxq 'game_port=30030' <<<"${third}"
grep -Fxq 'rcon_port=30031' <<<"${third}"
grep -Fxq 'game_port_2=30032' <<<"${third}"
grep -Fxq 'connect_port=30030' <<<"${third}"

factorio_first="$(WORLD_ID=base WORLD_FOOTPRINT_MEMORY_MIB=2048 SPAWNPOINT_SLOT=1 files_for factorio)"
grep -Fxq "files=${server}/games/factorio/compose.yaml:${server}/games/factorio/compose.footprint.yaml" <<<"${factorio_first}"
grep -Fxq 'game_port=30010' <<<"${factorio_first}"
grep -Fxq 'rcon_port=30011' <<<"${factorio_first}"

# An explicit project name is kept: the control plane may name one.
named="$(WORLD_ID=world WORLD_FOOTPRINT_MEMORY_MIB=7168 SPAWNPOINT_SLOT=0 SERVER_COMPOSE_PROJECT=custom files_for minecraft)"
grep -Fxq 'project=custom' <<<"${named}"

# --- what a slot refuses ---
expect_failure "slot out of range" env WORLD_ID=world WORLD_FOOTPRINT_MEMORY_MIB=7168 SPAWNPOINT_SLOT=256 bash -c "$(declare -f files_for); server='${server}'; files_for minecraft"
expect_failure "slot not a number" env WORLD_ID=world WORLD_FOOTPRINT_MEMORY_MIB=7168 SPAWNPOINT_SLOT=one bash -c "$(declare -f files_for); server='${server}'; files_for minecraft"
expect_failure "placed session without a world" env WORLD_FOOTPRINT_MEMORY_MIB=7168 SPAWNPOINT_SLOT=1 bash -c "$(declare -f files_for); server='${server}'; files_for minecraft"
expect_failure "placed session without a footprint" env WORLD_ID=world SPAWNPOINT_SLOT=1 bash -c "$(declare -f files_for); server='${server}'; files_for minecraft"
# Zomboid tells its clients which port to continue on, so it runs on slot zero only.
expect_failure "zomboid off slot zero" env WORLD_ID=z WORLD_FOOTPRINT_MEMORY_MIB=8192 SPAWNPOINT_SLOT=1 bash -c "$(declare -f files_for); server='${server}'; files_for zomboid"
zomboid_zero="$(WORLD_ID=z WORLD_FOOTPRINT_MEMORY_MIB=8192 SPAWNPOINT_SLOT=0 files_for zomboid)"
grep -Fxq 'game_port=16261' <<<"${zomboid_zero}"
grep -Fxq 'rcon_port=27015' <<<"${zomboid_zero}"

printf 'result=passed\n'
