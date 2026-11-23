#!/usr/bin/env bash

# The Source RCON probe transport, shared by every game whose server speaks it
# (factorio, zomboid). A game module sources this file and names the host,
# port, password and command; the client is the same for all of them.
#
# shellcheck shell=bash

RCON_PROBE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

# Print the reply to one command; the status is the client's.
rcon_query() {
  local host="$1" port="$2" password="$3" command="$4"
  python3 "${RCON_PROBE_DIR}/rcon-client.py" "${host}" "${port}" "${password}" "${command}"
  return $?
}
