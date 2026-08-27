#!/usr/bin/env python3
"""Minimal Source RCON client for the Factorio probe.

Standard library only, one round trip: authenticate, execute one command,
print the response. Exit codes: 0 response printed, 2 usage, 3 connection
failed, 4 authentication refused. The probe treats every non-zero as
"unavailable", which the watchdog counts as not-empty — fail closed.
"""

import socket
import struct
import sys

SERVERDATA_AUTH = 3
SERVERDATA_AUTH_RESPONSE = 2
SERVERDATA_EXECCOMMAND = 2
SERVERDATA_RESPONSE_VALUE = 0


def send_packet(sock: socket.socket, request_id: int, packet_type: int, body: str) -> None:
    payload = struct.pack("<ii", request_id, packet_type) + body.encode("utf-8") + b"\x00\x00"
    sock.sendall(struct.pack("<i", len(payload)) + payload)


def read_packet(sock: socket.socket) -> tuple[int, int, bytes]:
    header = b""
    while len(header) < 4:
        chunk = sock.recv(4 - len(header))
        if not chunk:
            raise ConnectionError("connection closed while reading length")
        header += chunk
    (length,) = struct.unpack("<i", header)
    payload = b""
    while len(payload) < length:
        chunk = sock.recv(length - len(payload))
        if not chunk:
            raise ConnectionError("connection closed while reading payload")
        payload += chunk
    request_id, packet_type = struct.unpack("<ii", payload[:8])
    return request_id, packet_type, payload[8:-2]


def main() -> int:
    if len(sys.argv) != 5:
        print("usage: rcon-client.py <host> <port> <password> <command>", file=sys.stderr)
        return 2
    host, port, password, command = sys.argv[1], int(sys.argv[2]), sys.argv[3], sys.argv[4]

    try:
        with socket.create_connection((host, port), timeout=10) as sock:
            sock.settimeout(10)
            send_packet(sock, 1, SERVERDATA_AUTH, password)
            # Some servers send an empty RESPONSE_VALUE before the auth reply.
            while True:
                request_id, packet_type, _ = read_packet(sock)
                if packet_type == SERVERDATA_AUTH_RESPONSE:
                    break
            if request_id == -1:
                print("error: rcon authentication refused", file=sys.stderr)
                return 4

            send_packet(sock, 2, SERVERDATA_EXECCOMMAND, command)
            request_id, packet_type, body = read_packet(sock)
            if packet_type != SERVERDATA_RESPONSE_VALUE or request_id != 2:
                print("error: unexpected rcon response", file=sys.stderr)
                return 3
            sys.stdout.write(body.decode("utf-8", errors="replace"))
            if body and not body.endswith(b"\n"):
                sys.stdout.write("\n")
            return 0
    except (OSError, ConnectionError) as error:
        print(f"error: rcon connection failed: {error}", file=sys.stderr)
        return 3


if __name__ == "__main__":
    sys.exit(main())
