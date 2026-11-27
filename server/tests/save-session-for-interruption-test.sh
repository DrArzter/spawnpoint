#!/usr/bin/env bash

# One session's save for a Spot interruption (ADR-0103), with the real game
# modules and a stubbed docker. A game that saves while it runs (Minecraft) is
# saved only when the save reaches the disk after the notice; a deferred answer
# is not a save. A game that saves only on a graceful stop (Zomboid) is stopped
# on the notice and left running on a rebalance recommendation.

set -Eeuo pipefail

repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
scripts="${repository_root}/server/scripts"
fixture="$(mktemp -d /tmp/spawnpoint-interruption-save-test.XXXXXXXX)"
trap 'rm -rf -- "${fixture}"' EXIT

mkdir -p -- "${fixture}/bin" "${fixture}/states"
export PATH="${fixture}/bin:${PATH}"
export FAKE_STATES_DIR="${fixture}/states"

# A fake container is a file named for its service, holding its state. The
# console answers a save, and a save or a graceful stop writes FAKE_SAVE_FILE
# unless FAKE_NO_WRITE is set: a game that answered but never reached the disk.
cat >"${fixture}/bin/docker" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
args=("$@")
write_save() {
  [[ -n "${FAKE_NO_WRITE:-}" || -z "${FAKE_SAVE_FILE:-}" ]] || { mkdir -p -- "$(dirname -- "${FAKE_SAVE_FILE}")"; date >"${FAKE_SAVE_FILE}"; }
}
if [[ "${args[0]}" == "compose" ]]; then
  if [[ " ${args[*]} " == *" exec "* ]]; then
    [[ "${args[$((${#args[@]} - 1))]}" != "flush" ]] || { write_save; printf 'Saved the game\n'; }
    exit 0
  fi
  service="${args[$((${#args[@]} - 1))]}"
  for arg in "${args[@]}"; do
    case "${arg}" in
      config) exit 0 ;;
      ps)
        [[ ! -f "${FAKE_STATES_DIR}/${service}" ]] || printf 'fake-%s\n' "${service}"
        exit 0
        ;;
      stop)
        write_save
        for state_file in "${FAKE_STATES_DIR}"/*; do
          [[ ! -f "${state_file}" ]] || printf 'exited\n' >"${state_file}"
        done
        exit 0
        ;;
    esac
  done
  exit 64
fi
[[ "${args[0]}" != "ps" ]] || exit 0
if [[ "${args[0]}" == "inspect" ]]; then
  cat "${FAKE_STATES_DIR}/${args[$((${#args[@]} - 1))]#fake-}"
  exit 0
fi
exit 64
STUB
chmod 0755 "${fixture}/bin/docker"

printf 'AWS_REGION=eu-central-1\n' >"${fixture}/runtime.env"
export SERVER_ENV_FILE="${fixture}/runtime.env"
export SPAWNPOINT_WORLDS_DIRECTORY="${fixture}/worlds"

generation="gen-cccccccccccccccccccccccccccccccc"
jq --arg generation "${generation}" '
  .worlds += [
    {id: "minecraft-live-1a2b3c4d", display_name: "Live", profile_id: "industrial", game: "minecraft",
     connectivity: "raw", auth: "game", storage_layout: "generation", generation_id: $generation, release: "1.2"},
    {id: "zomboid-stop-1a2b3c4d", display_name: "Stop", profile_id: "zomboid-vanilla", game: "zomboid",
     connectivity: "raw", auth: "game", storage_layout: "generation", generation_id: $generation, release: "1.0"}
  ]
' "${repository_root}/server/worlds/catalog.json" >"${fixture}/catalog.json"
export SPAWNPOINT_WORLD_CATALOG="${fixture}/catalog.json"

data_of() {
  printf '%s' "${fixture}/worlds/$1/generations/${generation}/data"
}

value_of() {
  awk -F= -v key="$1" '$1 == key { print substr($0, index($0, "=") + 1) }' <<<"$2"
}

save() {
  WORLD_ID="$1" "${scripts}/save-session-for-interruption.sh" "$2" "$(($(date +%s) - 1))"
}

# --- a game that saves while it runs ---
live_data="$(data_of minecraft-live-1a2b3c4d)"
mkdir -p -- "${live_data}/world"
printf 'old\n' >"${live_data}/world/level.dat"
touch -d '2 hours ago' -- "${live_data}/world/level.dat"
printf 'running\n' >"${FAKE_STATES_DIR}/mc"

output="$(FAKE_SAVE_FILE="${live_data}/world/level.dat" save minecraft-live-1a2b3c4d notice)"
[[ "$(value_of result "${output}")" == "saved" ]]
[[ "$(value_of method "${output}")" == "live" ]]
[[ "$(cat "${FAKE_STATES_DIR}/mc")" == "running" ]] # players stay until the host goes

# A save that answers but never reaches the disk is not a save.
touch -d '2 hours ago' -- "${live_data}/world/level.dat"
code=0
output="$(FAKE_NO_WRITE=1 FAKE_SAVE_FILE="${live_data}/world/level.dat" save minecraft-live-1a2b3c4d notice)" || code=$?
(( code != 0 ))
[[ "$(value_of result "${output}")" == "failed" ]]
[[ "$(value_of reason "${output}")" == "save_not_on_disk" ]]

# A recommendation saves a game that saves while it runs.
output="$(FAKE_SAVE_FILE="${live_data}/world/level.dat" save minecraft-live-1a2b3c4d rebalance)"
[[ "$(value_of result "${output}")" == "saved" ]]

# --- a game that saves only on a graceful stop ---
rm -f -- "${FAKE_STATES_DIR}/mc"
stop_data="$(data_of zomboid-stop-1a2b3c4d)"
mkdir -p -- "${stop_data}/Saves/Multiplayer/servertest"
map="${stop_data}/Saves/Multiplayer/servertest/map_t.bin"
printf 'old\n' >"${map}"
touch -d '2 hours ago' -- "${map}"
printf 'running\n' >"${FAKE_STATES_DIR}/zomboid"

# A recommendation does not stop it.
output="$(FAKE_SAVE_FILE="${map}" save zomboid-stop-1a2b3c4d rebalance)"
[[ "$(value_of result "${output}")" == "skipped" ]]
[[ "$(value_of method "${output}")" == "stop" ]]
[[ "$(cat "${FAKE_STATES_DIR}/zomboid")" == "running" ]]

# The notice stops it, and the stop's save is checked on the disk.
output="$(FAKE_SAVE_FILE="${map}" save zomboid-stop-1a2b3c4d notice)"
[[ "$(value_of result "${output}")" == "saved" ]]
[[ "$(value_of method "${output}")" == "stop" ]]
[[ "$(cat "${FAKE_STATES_DIR}/zomboid")" == "exited" ]]

# Every branch prints the same keys.
for key in result method reason seconds; do
  grep -q "^${key}=" <<<"${output}"
done

printf 'interruption save tests passed\n'
