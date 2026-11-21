#!/usr/bin/env python3
"""Minimal Steam A2S client for a game's player probe (ADR-0075).

Standard library only. Two queries over UDP: A2S_INFO, then A2S_PLAYER,
each answering a challenge when the server asks for one. Prints what both
say, as key=value lines, for a parser that refuses unless they agree:

    info_players=<players A2S_INFO counts, bots included>
    info_max_players=<slots>
    info_bots=<bots A2S_INFO counts>
    player_entries=<entries A2S_PLAYER lists>

Player names are read past, never printed: the probe needs a count only.

Exit codes: 0 printed, 2 usage, 3 no answer, 4 an answer this client does
not understand (a split packet, a truncated or unknown reply). The probe
treats every non-zero as "unavailable", which the watchdog counts as
not-empty: fail closed.
"""

import socket
import struct
import sys

HEADER = b"\xff\xff\xff\xff"
SPLIT_HEADER = b"\xfe\xff\xff\xff"
A2S_INFO = b"T" + b"Source Engine Query\x00"
A2S_PLAYER = b"U"
S2C_CHALLENGE = 0x41
INFO_REPLY = 0x49
PLAYER_REPLY = 0x44
NO_CHALLENGE = b"\xff\xff\xff\xff"
# The Ship's id: its A2S_INFO carries three extra bytes before the version.
THE_SHIP_APP_ID = 2400

TIMEOUT_SECONDS = 3
ATTEMPTS = 3
CHALLENGE_ROUNDS = 3


class NoAnswer(Exception):
    pass


class NotUnderstood(Exception):
    pass


class Reader:
    def __init__(self, data: bytes) -> None:
        self.data = data
        self.offset = 0

    def take(self, size: int) -> bytes:
        if self.offset + size > len(self.data):
            raise NotUnderstood("reply ends early")
        chunk = self.data[self.offset:self.offset + size]
        self.offset += size
        return chunk

    def byte(self) -> int:
        return self.take(1)[0]

    def short(self) -> int:
        return struct.unpack("<h", self.take(2))[0]

    def string(self) -> bytes:
        end = self.data.find(b"\x00", self.offset)
        if end < 0:
            raise NotUnderstood("string is not terminated")
        value = self.data[self.offset:end]
        self.offset = end + 1
        return value


def exchange(sock: socket.socket, request: bytes) -> bytes:
    for _ in range(ATTEMPTS):
        sock.send(HEADER + request)
        try:
            reply = sock.recv(65535)
        except socket.timeout:
            continue
        if reply.startswith(SPLIT_HEADER):
            raise NotUnderstood("split replies are not supported")
        if not reply.startswith(HEADER) or len(reply) < 5:
            raise NotUnderstood("reply has no A2S header")
        return reply[4:]
    raise NoAnswer("no reply")


# A server may answer either query with a challenge; the query is then sent
# again with the challenge appended (A2S_INFO) or in place (A2S_PLAYER).
def query(sock: socket.socket, build, expected: int) -> Reader:
    challenge = NO_CHALLENGE
    for _ in range(CHALLENGE_ROUNDS):
        reply = exchange(sock, build(challenge))
        kind = reply[0]
        if kind == S2C_CHALLENGE:
            challenge = Reader(reply[1:]).take(4)
            continue
        if kind != expected:
            raise NotUnderstood(f"unexpected reply type 0x{kind:02x}")
        return Reader(reply[1:])
    raise NotUnderstood("challenge was not accepted")


def read_info(sock: socket.socket) -> dict:
    reader = query(sock, lambda c: A2S_INFO if c == NO_CHALLENGE else A2S_INFO + c, INFO_REPLY)
    reader.byte()  # protocol
    for _ in range(4):  # name, map, folder, game
        reader.string()
    app_id = reader.short()
    players, max_players, bots = reader.byte(), reader.byte(), reader.byte()
    reader.take(4)  # server type, environment, visibility, VAC
    if app_id == THE_SHIP_APP_ID:
        reader.take(3)
    reader.string()  # version
    if bots > players:
        raise NotUnderstood("more bots than players")
    return {"players": players, "max_players": max_players, "bots": bots}


def read_player_entries(sock: socket.socket) -> int:
    reader = query(sock, lambda c: A2S_PLAYER + c, PLAYER_REPLY)
    count = reader.byte()
    for _ in range(count):
        reader.byte()  # index
        reader.string()  # name
        reader.take(8)  # score, duration
    if reader.offset != len(reader.data):
        raise NotUnderstood("player list is longer than its count")
    return count


# The game server runs on this host. Looking the argument up yields a fixed
# address, so no caller-supplied host reaches the socket (SSRF guard).
LOOPBACK_ADDRESSES = {"127.0.0.1": "127.0.0.1", "localhost": "127.0.0.1"}


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: a2s-client.py <host> <port>", file=sys.stderr)
        return 2
    host = LOOPBACK_ADDRESSES.get(sys.argv[1])
    if host is None:
        print("error: only a loopback address is accepted", file=sys.stderr)
        return 2
    try:
        port = int(sys.argv[2])
    except ValueError:
        print("error: the port must be a number", file=sys.stderr)
        return 2
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.settimeout(TIMEOUT_SECONDS)
            sock.connect((host, port))
            info = read_info(sock)
            entries = read_player_entries(sock)
    except NotUnderstood as error:
        print(f"error: a2s reply not understood: {error}", file=sys.stderr)
        return 4
    except (NoAnswer, OSError) as error:
        print(f"error: a2s query failed: {error}", file=sys.stderr)
        return 3
    print(f"info_players={info['players']}")
    print(f"info_max_players={info['max_players']}")
    print(f"info_bots={info['bots']}")
    print(f"player_entries={entries}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
