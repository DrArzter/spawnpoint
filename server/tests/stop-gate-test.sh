#!/usr/bin/env bash

# A stop succeeds only when this world's archive is verified on the host it
# ran on (ADR-0073). A game that is already stopped is not proof of a backup:
# an earlier attempt may have failed its upload, or the stop may have reached a
# host that never held the world. Stubbed docker, the fake S3 of the backup tests.

set -Eeuo pipefail

repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
scripts="${repository_root}/server/scripts"
fixture="$(mktemp -d /tmp/spawnpoint-stop-gate-test.XXXXXXXX)"
cleanup() {
  rm -rf -- "${fixture}"
}
trap cleanup EXIT

world_id="minecraft-gate-1a2b3c4d"
generation="gen-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
mkdir -p -- "${fixture}/bin" "${fixture}/s3/backups" "${fixture}/states"
export PATH="${fixture}/bin:${PATH}"
export FAKE_S3_ROOT="${fixture}/s3"
export FAKE_STATES_DIR="${fixture}/states"
export FAIL_UPLOADS="${fixture}/fail-uploads"
export BACKUP_BUCKET=backups
export AWS_REGION=eu-central-1

# The fake S3, with a switch that makes every upload fail.
cat >"${fixture}/bin/aws" <<STUB
#!/usr/bin/env bash
set -euo pipefail
if [[ -f "\${FAIL_UPLOADS}" && " \$* " == *" put-object "* ]]; then
  printf 'An error occurred (InternalError) when calling the PutObject operation\n' >&2
  exit 255
fi
exec "${repository_root}/server/tests/fake-aws" "\$@"
STUB
chmod 0755 "${fixture}/bin/aws"

# A fake container is a file named for its service, holding its state. The host
# has no other game, so the host-activity sensor reports idle.
cat >"${fixture}/bin/docker" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
args=("$@")
if [[ "${args[0]}" == "compose" ]]; then
  service="${args[$((${#args[@]} - 1))]}"
  for arg in "${args[@]}"; do
    case "${arg}" in
      config) exit 0 ;;
      ps)
        [[ ! -f "${FAKE_STATES_DIR}/${service}" ]] || printf 'fake-%s\n' "${service}"
        exit 0
        ;;
      stop)
        for state_file in "${FAKE_STATES_DIR}"/*; do
          [[ ! -f "${state_file}" ]] || printf 'exited\n' >"${state_file}"
        done
        exit 0
        ;;
    esac
  done
  exit 64
fi
if [[ "${args[0]}" == "ps" ]]; then
  exit 0
fi
if [[ "${args[0]}" == "inspect" ]]; then
  cat "${FAKE_STATES_DIR}/${args[$((${#args[@]} - 1))]#fake-}"
  exit 0
fi
exit 64
STUB
chmod 0755 "${fixture}/bin/docker"

printf 'BACKUP_BUCKET=backups\nAWS_REGION=eu-central-1\n' >"${fixture}/runtime.env"
export SERVER_ENV_FILE="${fixture}/runtime.env"

jq --arg id "${world_id}" --arg generation "${generation}" '
  .worlds += [{
    id: $id, display_name: "Gate", profile_id: "industrial", game: "minecraft",
    connectivity: "zerotier", storage_layout: "generation", generation_id: $generation, release: "1.2"
  }]
' "${repository_root}/server/worlds/catalog.json" >"${fixture}/catalog.json"
export SPAWNPOINT_WORLD_CATALOG="${fixture}/catalog.json"

world_on() {
  printf '%s' "${fixture}/hosts/$1/${world_id}/generations/${generation}"
}

# One host's view: its own worlds directory and its own archive directory.
stop_on() {
  local host="$1"
  SPAWNPOINT_WORLDS_DIRECTORY="${fixture}/hosts/${host}" SERVER_BACKUP_DIR="${fixture}/archives/${host}" \
    WORLD_ID="${world_id}" "${scripts}/stop-session.sh"
}

play() {
  local directory="$1" level="$2"
  sleep 1 # archive names carry the second they were taken
  mkdir -p -- "${directory}/data/world"
  printf '%s\n' "${level}" >"${directory}/data/world/level.dat"
  return 0
}

recorded_key() {
  jq -r '.key // "null"' "$1/.spawnpoint-archive.json"
}

result_of() {
  awk -F= '$1 == "result" { line = substr($0, index($0, "=") + 1) } END { print line }' <<<"$1"
}

object_count() {
  find "${FAKE_S3_ROOT}/backups" -type f -name '*.tar.zst' | wc -l | tr -d ' '
}

SPAWNPOINT_WORLDS_DIRECTORY="${fixture}/hosts/a" "${scripts}/prepare-world.sh" "${world_id}" >/dev/null
a_world="$(world_on a)"

# --- a prepared wipe that never saved has nothing to lose ---
output="$(stop_on a)"
[[ "$(result_of "${output}")" == "already_stopped_and_backed_up" ]]
[[ "$(object_count)" == "0" ]]

# --- the game saved and exited, then the upload failed: the stop fails ---
play "${a_world}" "session one"
printf 'exited\n' >"${FAKE_STATES_DIR}/mc"
: >"${FAIL_UPLOADS}"
code=0
output="$(stop_on a 2>"${fixture}/failed-stop.err")" || code=$?
(( code != 0 ))
[[ "$(result_of "${output}")" == "" ]]
[[ "$(object_count)" == "0" ]]
[[ "$(recorded_key "${a_world}")" == "null" ]]

# --- the retry finds the game already stopped, and still archives and uploads ---
rm -f -- "${FAIL_UPLOADS}"
sleep 1
output="$(stop_on a)"
[[ "$(result_of "${output}")" == "session_stopped_and_backed_up" ]]
grep -qx 'host=idle' <<<"${output}"
[[ "$(object_count)" == "1" ]]
uploaded="$(awk -F= '$1 == "object_key" { print substr($0, index($0, "=") + 1) }' <<<"${output}")"
[[ -n "${uploaded}" && "$(recorded_key "${a_world}")" == "${uploaded}" ]]

# --- nothing changed since that upload: done, with no second archive ---
output="$(stop_on a)"
[[ "$(result_of "${output}")" == "already_stopped_and_backed_up" ]]
[[ "$(object_count)" == "1" ]]

# --- the game ran again and exited alone: the new progress is archived ---
play "${a_world}" "session two"
output="$(stop_on a)"
[[ "$(result_of "${output}")" == "session_stopped_and_backed_up" ]]
[[ "$(object_count)" == "2" ]]

# --- a host that never held the world refuses; it cannot vouch for the archive ---
code=0
output="$(stop_on b 2>"${fixture}/elsewhere.err")" || code=$?
[[ "${code}" == "6" ]]
[[ "$(result_of "${output}")" == "world_not_on_host" ]]
grep -q 'no data on this host' "${fixture}/elsewhere.err"
rm -f -- "${FAKE_STATES_DIR}/mc"
code=0
output="$(stop_on b 2>/dev/null)" || code=$?
[[ "${code}" == "6" ]]
[[ "$(object_count)" == "2" ]]

printf 'stop-gate-test: ok\n'
