#!/usr/bin/env bash
# Writes the ignored backend.hcl of every remote-state root for the account
# the AWS profile signs in to, in the same shape terraform-init-ci.sh uses.
# The bucket is the one infra/terraform-bootstrap creates. An existing file is
# kept unless --force is given.

set -Eeuo pipefail

force=false
case "${1:-}" in
  "") ;;
  --force) force=true ;;
  *)
    printf 'usage: write-backend-config.sh [--force]\n' >&2
    exit 2
    ;;
esac

repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
profile="${AWS_PROFILE:-spawnpoint}"
region="${AWS_REGION:-eu-central-1}"
account_id="$(aws sts get-caller-identity --profile "${profile}" --query Account --output text)"
[[ "${account_id}" =~ ^[0-9]{12}$ ]] || {
  printf 'error: no account id from profile %s\n' "${profile}" >&2
  exit 1
}

for example in "${repository_root}"/infra/*/backend.hcl.example; do
  target="${example%.example}"
  state_key="$(sed -nE 's/^key[[:space:]]*=[[:space:]]*"([^"]+)".*/\1/p' "${example}")"
  [[ -n "${state_key}" ]] || {
    printf 'error: no backend key in %s\n' "${example}" >&2
    exit 1
  }
  if [[ -e "${target}" && "${force}" != true ]]; then
    printf 'kept    %s\n' "${target#"${repository_root}/"}"
    continue
  fi
  cat >"${target}" <<HCL
bucket       = "spawnpoint-tfstate-${account_id}"
key          = "${state_key}"
region       = "${region}"
profile      = "${profile}"
encrypt      = true
use_lockfile = true
HCL
  printf 'written %s\n' "${target#"${repository_root}/"}"
done
