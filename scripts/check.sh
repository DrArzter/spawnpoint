#!/usr/bin/env bash

# The whole evidence ladder's local rungs, as one command. Everything here
# runs without AWS credentials and cannot create resources; the AWS acceptance
# rung stays in the runbook where it belongs. Requires docker and node.
#
#   scripts/check.sh          run everything
#   scripts/check.sh fast     skip the terraform container (the slowest rung)
#   scripts/check.sh static   markdown, workflow and shell checks
#   scripts/check.sh app      Lambda tests and builds plus the web build
#   scripts/check.sh server   container and compose server suites
#   scripts/check.sh terraform

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
      server/scripts/*.sh server/connectivity/*.sh server/games/_dispatch.sh server/games/*/game.sh \
      scripts/*.sh scripts/config-sources/*.sh server/tests/*.sh server/user-data.sh'
}

check_workflows() {
  python3 scripts/check-workflows.py
}

check_deployment_plan() {
  python3 -m unittest discover -s scripts/tests -p '*_test.py'
}

check_node() {
  (cd lambdas && npm test)
}

check_web() {
  (cd web && npm test && npm run build)
}

# The bot, notifier and access-api roots archive lambdas/dist/*, so a Terraform
# plan needs the bundles to exist. Building them here rather than in CI keeps
# the ladder identical in both places, which is the whole point of one command.
check_lambda_bundles() {
  (cd lambdas && npm run build)
}

check_server_suite() {
  docker run --rm -v "${REPOSITORY_ROOT}:/repo:ro" "${ALPINE_IMAGE}" sh -c '
    apk add -q bash coreutils findutils diffutils tar zstd jq util-linux openssl curl zip unzip python3 git rsync >/dev/null
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

# Roots are discovered, not listed: the list had to be extended by hand the day
# the access, bot and web roots landed, and the next root would be remembered
# or not.
check_terraform() {
  local root
  while IFS= read -r root; do
    check_terraform_root "${root}" || return 1
  done < <(find infra -mindepth 1 -maxdepth 1 -type d \
    -exec sh -c 'ls "$1"/*.tf >/dev/null 2>&1' _ {} \; -print | sort)
}

check_terraform_root() {
  local root="$1"
  if [[ "${root}" != infra/* || ! -d "${REPOSITORY_ROOT}/${root}" || ! -f "${REPOSITORY_ROOT}/${root}/versions.tf" ]]; then
    printf 'invalid Terraform root: %s\n' "${root}" >&2
    return 2
  fi
  printf -- '--- %s\n' "${root}"
  docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp/terraform-home \
    -v "${REPOSITORY_ROOT}:/workspace" -w "/workspace/${root}" \
    "${TERRAFORM_IMAGE}" fmt -check || return 1
  docker run --rm --user "$(id -u):$(id -g)" \
    -e HOME=/tmp/terraform-home -e TF_DATA_DIR=/tmp/terraform-data \
    -v "${REPOSITORY_ROOT}:/workspace" -w "/workspace/${root}" \
    --entrypoint sh "${TERRAFORM_IMAGE}" -c \
    'terraform init -backend=false -input=false >/dev/null && terraform test -var=aws_profile='
}

run_static() {
  step "markdown links" check_links
  step "shellcheck" check_shell
  step "workflow hygiene" check_workflows
  step "deployment change classifier" check_deployment_plan
}

run_app() {
  step "node tests (lambdas)" check_node
  step "production build (mini app)" check_web
  step "lambda bundles" check_lambda_bundles
}

run_server() {
  step "server test suite (container)" check_server_suite
  step "compose bindings (host docker)" check_compose_bindings
}

run_terraform() {
  step "terraform fmt+test (all roots)" check_terraform
}

case "${mode}" in
  full)
    run_static
    run_app
    run_server
    run_terraform
    ;;
  fast)
    run_static
    run_app
    run_server
    ;;
  static) run_static ;;
  app) run_app ;;
  server) run_server ;;
  terraform)
    step "lambda bundles" check_lambda_bundles
    run_terraform
    ;;
  terraform-root)
    if [[ $# -ne 2 ]]; then
      printf 'usage: scripts/check.sh terraform-root infra/terraform-root\n' >&2
      exit 2
    fi
    step "terraform fmt+test (${2})" check_terraform_root "$2"
    ;;
  *)
    printf 'usage: scripts/check.sh [full|fast|static|app|server|terraform]\n' >&2
    exit 2
    ;;
esac

if (( ${#failures[@]} > 0 )); then
  printf '\nfailed: %s\n' "${failures[*]}"
  exit 1
fi
printf '\nall checks passed\n'
