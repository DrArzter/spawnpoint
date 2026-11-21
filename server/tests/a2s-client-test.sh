#!/usr/bin/env bash

# The shared A2S probe (ADR-0075): the client's real UDP round trips against a
# fake server, with and without challenges, and the parser's agreement rule,
# which turns any disagreement between A2S_INFO and A2S_PLAYER into a refusal.

set -Eeuo pipefail

REPOSITORY_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
PROBES="${REPOSITORY_ROOT}/server/games/_probes"
fixture="$(mktemp -d /tmp/spawnpoint-a2s-client-test.XXXXXXXX)"
fake_pid=""
cleanup() {
  [[ -z "${fake_pid}" ]] || kill "${fake_pid}" 2>/dev/null || true
  rm -rf -- "${fixture}"
}
trap cleanup EXIT

cat >"${fixture}/fake-a2s.py" <<'FAKE_A2S'
import socket, struct, sys

# scenario: challenge|plain, then players, bots, listed entries, and a player
# reply shape: good|split|long|short|silent|wrongtype
directory, challenge, players, bots, listed, shape = sys.argv[1:7]
players, bots, listed = int(players), int(bots), int(listed)
HEADER = b"\xff\xff\xff\xff"
TOKEN = b"\x0a\x0b\x0c\x0d"

def info():
    body = b"I" + b"\x11" + b"Spawnpoint\x00" + b"spawnpoint\x00" + b"valheim\x00" + b"Valheim\x00"
    body += struct.pack("<h", 892970 & 0x7FFF) + bytes([players, 10, bots]) + b"dl\x01\x00" + b"1.0.0\x00"
    return HEADER + body

def player_list():
    entries = b"".join(bytes([i]) + b"Viking\x00" + struct.pack("<if", 0, 12.5) for i in range(listed))
    count = listed
    if shape == "long":
        count = max(listed - 1, 0)
    if shape == "short":
        count = listed + 1
    return HEADER + b"D" + bytes([count]) + entries

server = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
server.bind(("127.0.0.1", 0))
open(directory + "/port", "w").write(str(server.getsockname()[1]))
log = open(directory + "/requests", "ab", buffering=0)

while True:
    data, peer = server.recvfrom(2048)
    log.write(data.hex().encode() + b"\n")
    kind, rest = data[4:5], data[5:]
    if kind == b"T":
        query = b"Source Engine Query\x00"
        assert rest.startswith(query), rest
        if challenge == "challenge" and rest[len(query):] != TOKEN:
            server.sendto(HEADER + b"A" + TOKEN, peer)
            continue
        server.sendto(info(), peer)
    elif kind == b"U":
        if shape == "silent":
            continue
        if challenge == "challenge" and rest != TOKEN:
            server.sendto(HEADER + b"A" + TOKEN, peer)
            continue
        if shape == "split":
            server.sendto(b"\xfe\xff\xff\xff" + b"\x00" * 12, peer)
        elif shape == "wrongtype":
            server.sendto(HEADER + b"E" + b"\x00", peer)
        else:
            server.sendto(player_list(), peer)
FAKE_A2S

start_fake() {
  rm -f -- "${fixture}/port" "${fixture}/requests"
  python3 "${fixture}/fake-a2s.py" "${fixture}" "$@" &
  fake_pid=$!
  for _ in $(seq 1 50); do
    [[ -s "${fixture}/port" ]] && break
    sleep 0.1
  done
  [[ -s "${fixture}/port" ]]
}

stop_fake() {
  kill "${fake_pid}" 2>/dev/null || true
  wait "${fake_pid}" 2>/dev/null || true
  fake_pid=""
}

# Run the client against the fake; print its output and remember its status.
query_fake() {
  status=0
  output="$(python3 "${PROBES}/a2s-client.py" 127.0.0.1 "$(cat "${fixture}/port")" 2>"${fixture}/stderr")" || status=$?
}

# shellcheck source=../games/_probes/a2s.sh
source "${PROBES}/a2s.sh"

# --- a server that asks for a challenge on both queries, two players online ---
start_fake challenge 2 0 2 good
query_fake
[[ "${status}" == 0 ]]
[[ "${output}" == "info_players=2
info_max_players=10
info_bots=0
player_entries=2" ]]
# Names are read past, never printed.
if grep -q "Viking" <<<"${output}"; then exit 1; fi
[[ "$(a2s_parse_player_count <<<"${output}")" == "2" ]]
# Each query went twice: once without the challenge, once with it.
[[ "$(grep -c '^ffffffff54' "${fixture}/requests")" == "2" ]]
grep -qx 'ffffffff550a0b0c0d' "${fixture}/requests"
stop_fake

# --- a server that answers at once, nobody online ---
start_fake plain 0 0 0 good
query_fake
[[ "${status}" == 0 ]]
[[ "$(a2s_parse_player_count <<<"${output}")" == "0" ]]
stop_fake

# --- bots count as players in A2S_INFO, and the probe counts humans only ---
start_fake plain 3 1 3 good
query_fake
[[ "$(a2s_parse_player_count <<<"${output}")" == "2" ]]
stop_fake

# --- the two queries disagree: the client reports both, the parser refuses ---
start_fake plain 2 0 0 good
query_fake
[[ "${status}" == 0 ]]
if a2s_parse_player_count <<<"${output}" >/dev/null 2>&1; then exit 1; fi
stop_fake
start_fake plain 0 0 1 good
query_fake
if a2s_parse_player_count <<<"${output}" >/dev/null 2>&1; then exit 1; fi
stop_fake

# --- replies this client does not understand are refusals, never a count ---
for shape in split long short wrongtype; do
  start_fake plain 1 0 1 "${shape}"
  query_fake
  [[ "${status}" == 4 ]] || { printf 'shape %s: status %s\n' "${shape}" "${status}" >&2; exit 1; }
  [[ -z "${output}" ]]
  stop_fake
done

# --- a server that never answers the player query, and a closed port ---
start_fake plain 0 0 0 silent
query_fake
[[ "${status}" == 3 ]]
[[ -z "${output}" ]]
stop_fake
closed_port="$(python3 -c 'import socket; s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')"
status=0
python3 "${PROBES}/a2s-client.py" 127.0.0.1 "${closed_port}" >/dev/null 2>&1 || status=$?
[[ "${status}" == 3 ]]
status=0
python3 "${PROBES}/a2s-client.py" 127.0.0.1 >/dev/null 2>&1 || status=$?
[[ "${status}" == 2 ]]

# --- the parser alone: every key once, as a small integer ---
[[ "$(a2s_parse_player_count <<<'info_players=1
info_max_players=10
info_bots=0
player_entries=1')" == "1" ]]
for raw in \
  'info_players=1
info_bots=0' \
  'info_players=1
info_players=0
info_bots=0
player_entries=1' \
  'info_players=-1
info_bots=0
player_entries=-1' \
  'info_players=2
info_bots=3
player_entries=2' \
  'There are 0 of a max of 20 players online:' \
  ''; do
  if a2s_parse_player_count <<<"${raw}" >/dev/null 2>&1; then
    printf 'expected refusal: %s\n' "${raw}" >&2
    exit 1
  fi
done

printf 'a2s-client-test: ok\n'
