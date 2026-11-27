#!/usr/bin/env bash

# The world log entry (ADR-0094): the game container's newest lines, bounded so
# SSM keeps them whole, and a missing container reported as its own exit.

set -Eeuo pipefail

repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
fixture="$(mktemp -d /tmp/spawnpoint-world-log-test.XXXXXXXX)"
cleanup() {
  rm -rf -- "${fixture}"
}
trap cleanup EXIT

mkdir -p -- "${fixture}/bin"
cat >"${fixture}/bin/docker" <<'FAKE'
#!/usr/bin/env bash

[[ "$1" == "compose" ]] || exit 90
shift
printf '%s\0' "$@" >"${FAKE_ARGUMENTS_FILE}"
for argument in "$@"; do
  case "${argument}" in
    config) exit 0 ;;
    logs)
      if [[ "${FAKE_LOGS_FAIL:-0}" == "1" ]]; then
        printf 'no such service\n' >&2
        exit 1
      fi
      printf 'time="2026-11-24T10:00:00Z" level=warning msg="compose noise"\n' >&2
      seq -f 'line %g' 1 "${FAKE_LOG_LINES:-3}"
      [[ -z "${FAKE_LOG_TAIL:-}" ]] || printf '%s\n' "${FAKE_LOG_TAIL}"
      exit 0
      ;;
  esac
done
exit 91
FAKE
chmod 0755 "${fixture}/bin/docker"

export PATH="${fixture}/bin:${PATH}"
export SERVER_PROJECT_DIRECTORY="${repository_root}/server"
export SERVER_COMPOSE_FILES="${repository_root}/server/compose.yaml:${repository_root}/server/compose.release.yaml"
export SERVER_ENV_FILE="${fixture}/missing.env"
export FAKE_ARGUMENTS_FILE="${fixture}/arguments"
world_log="${repository_root}/server/scripts/world-log.sh"

# The log as the game wrote it, and nothing Compose said about itself.
output="$("${world_log}" 2>/dev/null)"
[[ "${output}" == $'line 1\nline 2\nline 3' ]] || { printf 'unexpected log:\n%s\n' "${output}" >&2; exit 1; }
mapfile -d '' -t words <"${FAKE_ARGUMENTS_FILE}"
joined=" ${words[*]} "
[[ "${joined}" == *" logs --no-color --no-log-prefix --tail 200 "* ]] || {
  printf 'unexpected compose call:%s\n' "${joined}" >&2
  exit 1
}

# A game that prints its own arguments does not hand its secrets on: every
# secret of the .env is redacted, other values are not.
printf 'ZOMBOID_ADMIN_PASSWORD="s3cret-Value1"\nRCON_PASSWORD=another-secret\nAWS_REGION=eu-central-1\n' >"${fixture}/secret.env"
output="$(SERVER_ENV_FILE="${fixture}/secret.env" FAKE_LOG_TAIL='arg: s3cret-Value1 then another-secret in eu-central-1' "${world_log}" 2>/dev/null)"
[[ "${output}" == *'arg: [redacted] then [redacted] in eu-central-1' ]] || { printf 'secrets were not redacted:\n%s\n' "${output}" >&2; exit 1; }

# A long log keeps its newest bytes, within what SSM returns whole.
output="$(FAKE_LOG_LINES=5000 "${world_log}" 2>/dev/null)"
[[ "$(printf '%s\n' "${output}" | wc -c)" -le 20000 ]] || { printf 'the log was not bounded\n' >&2; exit 1; }
[[ "${output}" == *$'line 5000' ]] || { printf 'the newest line was lost\n' >&2; exit 1; }

# No container to read.
set +e
output="$(FAKE_LOGS_FAIL=1 "${world_log}" 2>&1)"
status=$?
set -e
[[ "${status}" == "3" ]] || { printf 'a missing container exited %s\n' "${status}" >&2; exit 1; }
grep -Fq 'no such service' <<<"${output}"

printf 'PASS world-log-test.sh\n'
