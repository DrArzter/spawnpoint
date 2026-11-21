#!/usr/bin/env bash

# The A2S probe transport (ADR-0075), shared by every game whose server
# answers Steam's query protocol. A game module sources this file and names
# the host and port; the client and the parser are the same for all of them.
#
# shellcheck shell=bash

A2S_PROBE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

# Print what A2S_INFO and A2S_PLAYER say; the status is the client's.
a2s_query_players() {
  local host="$1" port="$2"
  python3 "${A2S_PROBE_DIR}/a2s-client.py" "${host}" "${port}"
  return $?
}

# Humans online, only when the two queries agree. A2S_INFO counts players
# with bots included; A2S_PLAYER lists them. A server whose list disagrees
# with its own count is a server this parser does not understand, so it
# refuses: the probe reads that as "not idle", and the stop as a refusal.
a2s_parse_player_count() {
  local response players bots entries
  response="$(cat)"
  players="$(a2s_value info_players <<<"${response}")" || return 1
  bots="$(a2s_value info_bots <<<"${response}")" || return 1
  entries="$(a2s_value player_entries <<<"${response}")" || return 1
  (( bots <= players && entries == players )) || return 1
  printf '%s\n' "$((players - bots))"
}

# One key, present once, a decimal integer.
a2s_value() {
  local key="$1" values
  values="$(sed -nE "s/^${key}=([0-9]{1,3})\$/\\1/p")"
  [[ "${values}" =~ ^[0-9]{1,3}$ ]] || return 1
  printf '%s' "$((10#${values}))"
}
