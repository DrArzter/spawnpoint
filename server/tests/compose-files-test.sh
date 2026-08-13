#!/usr/bin/env bash

set -Eeuo pipefail

repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
fixture="$(mktemp -d /tmp/spawnpoint-compose-files-test.XXXXXXXX)"
cleanup() {
  rm -rf -- "${fixture}"
}
trap cleanup EXIT

mkdir -p -- "${fixture}/bin"
capture="${fixture}/docker-arguments"
cat >"${fixture}/bin/docker" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$@" >"${FAKE_DOCKER_CAPTURE}"
EOF
chmod 0755 "${fixture}/bin/docker"

export PATH="${fixture}/bin:${PATH}"
export FAKE_DOCKER_CAPTURE="${capture}"
export SERVER_PROJECT_DIRECTORY="${repository_root}/server"
export SERVER_COMPOSE_FILES="${repository_root}/server/compose.yaml:${repository_root}/server/compose.release.yaml"
export SERVER_ENV_FILE="${fixture}/missing.env"

# shellcheck source=../scripts/_common.sh
source "${repository_root}/server/scripts/_common.sh"
compose config --quiet

mapfile -t actual <"${capture}"
expected=(
  compose
  --project-directory "${repository_root}/server"
  -f "${repository_root}/server/compose.yaml"
  -f "${repository_root}/server/compose.release.yaml"
  config --quiet
)

[[ "${actual[*]}" == "${expected[*]}" ]] || {
  printf 'unexpected docker arguments\nactual:   %s\nexpected: %s\n' "${actual[*]}" "${expected[*]}" >&2
  exit 1
}

printf 'result=passed\n'
