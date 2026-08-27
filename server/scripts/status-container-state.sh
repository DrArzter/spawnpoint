#!/usr/bin/env bash

# One question, one answer: the state of one compose service's container.
# Split out so the host-activity sensor can ask it per game module in a
# subshell without re-sourcing _common's environment handling by hand.

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_common.sh
source "${SCRIPT_DIR}/_common.sh"

container_state
