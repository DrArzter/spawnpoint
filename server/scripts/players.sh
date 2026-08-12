#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_common.sh
source "${SCRIPT_DIR}/_common.sh"

response="$(rcon list)"
count="$(sed -nE 's/^There are ([0-9]+) of a max of [0-9]+ players online.*$/\1/p' <<<"${response}")"

if [[ -z "${count}" ]]; then
  log "could not parse player count from RCON response: ${response}"
  exit 1
fi

printf 'player_count=%s\n' "${count}"
printf 'minecraft_status=%s\n' "${response}"
