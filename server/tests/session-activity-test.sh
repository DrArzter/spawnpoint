#!/usr/bin/env bash

set -Eeuo pipefail

repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
fixture="$(mktemp -d /tmp/spawnpoint-session-activity-test.XXXXXXXX)"
cleanup() {
  rm -rf -- "${fixture}"
}
trap cleanup EXIT

mkdir -p -- "${fixture}/bin"
cat >"${fixture}/bin/docker" <<'EOF'
#!/usr/bin/env bash

if [[ "$1" == "inspect" ]]; then
  printf '%s\n' "${FAKE_CONTAINER_STATE:-running}"
  exit 0
fi

[[ "$1" == "compose" ]] || exit 90
shift

for argument in "$@"; do
  case "${argument}" in
    config)
      exit 0
      ;;
    ps)
      if [[ "${FAKE_CONTAINER_STATE:-running}" != "absent" ]]; then
        printf 'fake-container\n'
      fi
      exit 0
      ;;
    exec)
      if [[ "${FAKE_RCON_FAIL:-0}" == "1" ]]; then
        exit 1
      fi
      printf '%s\n' "${FAKE_RCON_RESPONSE:-There are 0 of a max of 20 players online:}"
      exit 0
      ;;
  esac
done

exit 91
EOF
chmod 0755 "${fixture}/bin/docker"

export PATH="${fixture}/bin:${PATH}"
export SERVER_PROJECT_DIRECTORY="${repository_root}/server"
export SERVER_COMPOSE_FILES="${repository_root}/server/compose.yaml:${repository_root}/server/compose.release.yaml"
export SERVER_ENV_FILE="${fixture}/missing.env"
probe="${repository_root}/server/scripts/check-session-activity.sh"

run_probe() {
  local expected_exit="$1"
  local output
  local actual_exit

  set +e
  output="$(${probe})"
  actual_exit=$?
  set -e

  [[ "${actual_exit}" == "${expected_exit}" ]] || {
    printf 'unexpected exit: got %s, expected %s\n%s\n' "${actual_exit}" "${expected_exit}" "${output}" >&2
    exit 1
  }
  printf '%s\n' "${output}"
}

assert_line() {
  local output="$1"
  local expected="$2"
  grep -Fxq -- "${expected}" <<<"${output}" || {
    printf 'missing output line %s in:\n%s\n' "${expected}" "${output}" >&2
    exit 1
  }
}

export FAKE_CONTAINER_STATE=running
export FAKE_RCON_FAIL=0
export FAKE_RCON_RESPONSE='There are 0 of a max of 20 players online:'
output="$(run_probe 0)"
assert_line "${output}" 'result=observed'
assert_line "${output}" 'activity=idle'
assert_line "${output}" 'players_online=0'

export FAKE_RCON_RESPONSE='There are 2 of a max of 20 players online: Alice, Bob'
output="$(run_probe 0)"
assert_line "${output}" 'activity=active'
assert_line "${output}" 'players_online=2'
if grep -Eq 'Alice|Bob' <<<"${output}"; then
  printf 'probe leaked player names:\n%s\n' "${output}" >&2
  exit 1
fi

export FAKE_RCON_RESPONSE='unexpected response'
output="$(run_probe 2)"
assert_line "${output}" 'activity=unknown'
assert_line "${output}" 'reason=player_count_unparseable'

export FAKE_RCON_FAIL=1
output="$(run_probe 2)"
assert_line "${output}" 'activity=unknown'
assert_line "${output}" 'reason=rcon_unavailable'

export FAKE_RCON_FAIL=0
export FAKE_CONTAINER_STATE=exited
output="$(run_probe 2)"
assert_line "${output}" 'activity=unknown'
assert_line "${output}" 'container_state=exited'
assert_line "${output}" 'reason=container_not_running'

export FAKE_CONTAINER_STATE=absent
output="$(run_probe 2)"
assert_line "${output}" 'activity=unknown'
assert_line "${output}" 'container_state=absent'

printf 'result=passed\n'
