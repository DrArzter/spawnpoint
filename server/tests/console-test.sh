#!/usr/bin/env bash

# The console entry (ADR-0063): one line an operator typed reaches the game's
# RCON as one literal argument, and nothing in it is ever run by a shell.

set -Eeuo pipefail

repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
fixture="$(mktemp -d /tmp/spawnpoint-console-test.XXXXXXXX)"
cleanup() {
  rm -rf -- "${fixture}"
}
trap cleanup EXIT

mkdir -p -- "${fixture}/bin"
cat >"${fixture}/bin/docker" <<'EOF'
#!/usr/bin/env bash

[[ "$1" == "compose" ]] || exit 90
shift
for argument in "$@"; do
  case "${argument}" in
    config) exit 0 ;;
    exec)
      # Everything after `rcon-cli` is what the game would receive.
      seen=0
      : >"${FAKE_ARGUMENTS_FILE}"
      for word in "$@"; do
        if [[ "${seen}" == "1" ]]; then printf '%s\0' "${word}" >>"${FAKE_ARGUMENTS_FILE}"; fi
        [[ "${word}" == "rcon-cli" ]] && seen=1
      done
      if [[ "${FAKE_RCON_FAIL:-0}" == "1" ]]; then
        printf 'Error: rcon connection refused\n' >&2
        exit 1
      fi
      printf '%s\n' "${FAKE_RCON_RESPONSE:-ok}"
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
export FAKE_ARGUMENTS_FILE="${fixture}/arguments"
console="${repository_root}/server/scripts/console.sh"

run_console() {
  local expected_exit="$1" command="$2"
  local output actual_exit
  set +e
  output="$(CONSOLE_COMMAND_B64="$(printf '%s' "${command}" | base64 | tr -d '\n')" "${console}" 2>&1)"
  actual_exit=$?
  set -e
  [[ "${actual_exit}" == "${expected_exit}" ]] || {
    printf 'unexpected exit for %q: got %s, expected %s\n%s\n' "${command}" "${actual_exit}" "${expected_exit}" "${output}" >&2
    exit 1
  }
  printf '%s\n' "${output}"
}

# The game's single argument, exactly as typed.
received() {
  local -a words=()
  mapfile -d '' -t words <"${FAKE_ARGUMENTS_FILE}"
  [[ "${#words[@]}" == "1" ]] || {
    printf 'expected one argument, got %s\n' "${#words[@]}" >&2
    exit 1
  }
  printf '%s' "${words[0]}"
}

export FAKE_RCON_RESPONSE='There are 2 of a max of 20 players online: Alice, Bob'
output="$(run_console 0 'list')"
[[ "${output}" == "${FAKE_RCON_RESPONSE}" ]]
[[ "$(received)" == "list" ]]

export FAKE_RCON_RESPONSE='[Server] hello there'
run_console 0 'say hello there' >/dev/null
[[ "$(received)" == "say hello there" ]] || { printf 'words were split: %s\n' "$(received)" >&2; exit 1; }

# Shell syntax is text to the game, never a command to this host.
marker="${fixture}/should-not-exist"
hostile="say \$(touch ${marker}); \`touch ${marker}\` && touch ${marker} | tee x 'quote\" ok"
run_console 0 "${hostile}" >/dev/null
[[ ! -e "${marker}" ]] || { printf 'a console command ran on the host\n' >&2; exit 1; }
[[ "$(received)" == "${hostile}" ]]

# Not one line of text: refused before the game is reached.
: >"${FAKE_ARGUMENTS_FILE}"
run_console 2 $'list\nstop' >/dev/null
run_console 2 $'list\n' >/dev/null
run_console 2 $'say\ttabbed' >/dev/null
run_console 2 '   ' >/dev/null
run_console 2 "$(printf 'a%.0s' $(seq 1 1025))" >/dev/null
[[ ! -s "${FAKE_ARGUMENTS_FILE}" ]] || { printf 'a refused command reached the game\n' >&2; exit 1; }
set +e
CONSOLE_COMMAND_B64='not base64!' "${console}" >/dev/null 2>&1
[[ $? == 2 ]] || { printf 'invalid base64 was not refused\n' >&2; exit 1; }
"${console}" >/dev/null 2>&1
[[ $? == 2 ]] || { printf 'a missing command was not refused\n' >&2; exit 1; }
set -e

# The game did not answer.
export FAKE_RCON_FAIL=1
output="$(run_console 3 'list')"
grep -Fq 'connection refused' <<<"${output}"

printf 'PASS console-test.sh\n'
