#!/usr/bin/env bash

# The whole evidence ladder's local rungs, as one command. Everything here
# runs without AWS credentials and cannot create resources; the AWS acceptance
# rung stays in the runbook where it belongs. Requires docker and node.
#
#   scripts/check.sh          run everything
#   scripts/check.sh fast     skip the terraform container (the slowest rung)

set -Eeuo pipefail

REPOSITORY_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd -- "${REPOSITORY_ROOT}"
mode="${1:-full}"

TERRAFORM_IMAGE="hashicorp/terraform:1.15.8"
ALPINE_IMAGE="alpine:3.20"

failures=()
step() {
  local name="$1"
  shift
  printf '==> %s\n' "${name}"
  if "$@"; then
    printf 'ok  %s\n' "${name}"
  else
    printf 'FAIL %s\n' "${name}"
    failures+=("${name}")
  fi
}

check_links() {
  python3 scripts/check-links.py
}

check_shell() {
  docker run --rm -v "${REPOSITORY_ROOT}:/repo:ro" "${ALPINE_IMAGE}" sh -c '
    apk add -q shellcheck >/dev/null
    cd /repo
    shellcheck -x -S warning \
      server/scripts/*.sh server/games/_dispatch.sh server/games/*/game.sh \
      scripts/*.sh server/tests/*.sh server/user-data.sh'
}

check_node() {
  (cd lambdas && npm test)
}

check_web() {
  (cd web && npm run build)
}

check_server_suite() {
  docker run --rm -v "${REPOSITORY_ROOT}:/repo:ro" "${ALPINE_IMAGE}" sh -c '
    apk add -q bash coreutils findutils diffutils tar zstd jq util-linux openssl curl zip unzip python3 git >/dev/null
    fail=0
    for t in /repo/server/tests/*-test.sh; do
      name="$(basename "$t")"
      # profile-resolver drives real docker; it has no daemon in this container.
      [ "$name" = "profile-resolver-test.sh" ] && continue
      # compose-bindings needs the real docker compose; it runs on the host below.
      [ "$name" = "compose-bindings-test.sh" ] && continue
      if bash "$t" >"/tmp/${name}.log" 2>&1; then
        echo "PASS ${name}"
      else
        echo "FAIL ${name}"; tail -8 "/tmp/${name}.log"; fail=1
      fi
    done
    exit $fail'
}

check_compose_bindings() {
  bash server/tests/compose-bindings-test.sh
}

check_terraform() {
  local root
  for root in infra/terraform infra/terraform-bootstrap infra/terraform-storage infra/terraform-guardrails infra/terraform-operations infra/terraform-releases infra/terraform-github infra/terraform-access infra/terraform-bot infra/terraform-web; do
    [[ -d "${root}" ]] || continue
    printf -- '--- %s\n' "${root}"
    docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp/terraform-home \
      -v "${REPOSITORY_ROOT}:/workspace" -w "/workspace/${root}" \
      "${TERRAFORM_IMAGE}" fmt -check || return 1
    docker run --rm --user "$(id -u):$(id -g)" \
      -e HOME=/tmp/terraform-home -e TF_DATA_DIR=/tmp/terraform-data \
      -v "${REPOSITORY_ROOT}:/workspace" -w "/workspace/${root}" \
      --entrypoint sh "${TERRAFORM_IMAGE}" -c \
      'terraform init -backend=false -input=false >/dev/null && terraform test -var=aws_profile=' || return 1
  done
}

step "markdown links" check_links
step "shellcheck" check_shell
step "node tests (lambdas)" check_node
step "production build (mini app)" check_web
step "server test suite (container)" check_server_suite
step "compose bindings (host docker)" check_compose_bindings
if [[ "${mode}" != "fast" ]]; then
  step "terraform fmt+test (all roots)" check_terraform
fi

if (( ${#failures[@]} > 0 )); then
  printf '\nfailed: %s\n' "${failures[*]}"
  exit 1
fi
printf '\nall checks passed\n'
