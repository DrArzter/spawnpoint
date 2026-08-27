#!/usr/bin/env bash

# The per-game adapter's contract (ADR-0034): a game module is data plus
# functions, minecraft is the byte-identical default, and factorio — the first
# tenant — exercises every axis: another transport, another parser, zip mods,
# zip saves, and an empty release that must still flow through download.

set -Eeuo pipefail

REPOSITORY_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPTS="${REPOSITORY_ROOT}/server/scripts"
GAMES="${REPOSITORY_ROOT}/server/games"
fixture="$(mktemp -d /tmp/spawnpoint-game-adapter-test.XXXXXXXX)"
cleanup() {
  rm -rf -- "${fixture}"
}
trap cleanup EXIT

expect_failure() {
  local label="$1"
  shift
  if "$@" >/dev/null 2>&1; then
    printf 'expected failure: %s\n' "${label}" >&2
    exit 1
  fi
}

# --- parsers: each game reads its own server's sentence, and only its own ---
(
  source "${GAMES}/minecraft/game.sh"
  [[ "$(game_parse_player_count <<<'There are 2 of a max of 20 players online: a, b')" == "2" ]]
  [[ "$(game_parse_player_count <<<'There are 0 of a max of 20 players online:')" == "0" ]]
  ! game_parse_player_count <<<'Online players (2):' >/dev/null
)
(
  source "${GAMES}/factorio/game.sh"
  [[ "$(game_parse_player_count <<<'Online players (1):
  arzter (online)')" == "1" ]]
  [[ "$(game_parse_player_count <<<'Online players (0):')" == "0" ]]
  ! game_parse_player_count <<<'There are 2 of a max of 20 players online:' >/dev/null
)

# --- the factorio transport: a real Source RCON round trip, faked server ---
python3 - "$fixture" <<'FAKE_RCON' &
import socket, struct, sys, threading

def packet(req_id, ptype, body):
    payload = struct.pack("<ii", req_id, ptype) + body + b"\x00\x00"
    return struct.pack("<i", len(payload)) + payload

def read(conn):
    length = struct.unpack("<i", conn.recv(4))[0]
    data = b""
    while len(data) < length:
        data += conn.recv(length - len(data))
    req_id, ptype = struct.unpack("<ii", data[:8])
    return req_id, ptype, data[8:-2]

server = socket.socket()
server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
server.bind(("127.0.0.1", 0))
server.listen(2)
open(sys.argv[1] + "/rcon-port", "w").write(str(server.getsockname()[1]))

for _ in range(2):
    conn, _addr = server.accept()
    req_id, ptype, body = read(conn)
    if body != b"correct-password":
        conn.sendall(packet(-1, 2, b""))
        conn.close()
        continue
    conn.sendall(packet(req_id, 2, b""))
    req_id, ptype, body = read(conn)
    assert body == b"/players online", body
    conn.sendall(packet(req_id, 0, b"Online players (0):"))
    conn.close()
server.close()
FAKE_RCON
fake_rcon_pid=$!
for _ in $(seq 1 50); do
  [[ -s "${fixture}/rcon-port" ]] && break
  sleep 0.1
done
rcon_port="$(cat "${fixture}/rcon-port")"

wrong="$(python3 "${GAMES}/factorio/rcon-client.py" 127.0.0.1 "${rcon_port}" "wrong-password" "/players online" 2>&1)" && {
  printf 'expected auth refusal\n' >&2
  exit 1
}
grep -q "authentication refused" <<<"${wrong}"

response="$(python3 "${GAMES}/factorio/rcon-client.py" 127.0.0.1 "${rcon_port}" "correct-password" "/players online")"
[[ "${response}" == "Online players (0):" ]]
wait "${fake_rcon_pid}"

# --- dispatch: the catalog names the game, absence means minecraft ---
output="$(WORLD_ID=factorio bash -c "source '${GAMES}/_dispatch.sh'; resolve_game; printf '%s %s %s\n' \"\${GAME_ID}\" \"\${GAME_COMPOSE_SERVICE}\" \"\${GAME_MOD_EXTENSION}\"")"
[[ "${output}" == "factorio factorio zip" ]]
output="$(WORLD_ID=main bash -c "source '${GAMES}/_dispatch.sh'; resolve_game; printf '%s\n' \"\${GAME_ID}\"")"
[[ "${output}" == "minecraft" ]]
output="$(bash -c "source '${GAMES}/_dispatch.sh'; resolve_game; printf '%s\n' \"\${GAME_ID}\"")"
[[ "${output}" == "minecraft" ]]
expect_failure "a world naming a game with no module" \
  env SPAWNPOINT_GAME=heroes-of-might bash -c "source '${GAMES}/_dispatch.sh'; resolve_game"

# world-profile reports the axis
profile_output="$("${SCRIPTS}/world-profile.sh" factorio)"
grep -qx 'game=factorio' <<<"${profile_output}"

# --- factorio saves: archive, verify with the per-game sentinel, restore ---
mkdir -p -- "${fixture}/factorio-data/saves" "${fixture}/backups"
printf 'zip fixture bytes\n' >"${fixture}/factorio-data/saves/spawnpoint.zip"
archive_output="$(
  SPAWNPOINT_GAME=factorio \
  SERVER_DATA_DIR="${fixture}/factorio-data" \
  SERVER_BACKUP_DIR="${fixture}/backups" \
  WORLD_NAME=factorio \
    "${SCRIPTS}/archive-world.sh"
)"
archive="$(awk -F= '$1 == "archive" { print $2 }' <<<"${archive_output}")"
listing="$(tar --list --zstd --file "${archive}")"
grep -qx 'saves/spawnpoint.zip' <<<"${listing}"

SPAWNPOINT_GAME=factorio WORLD_NAME=factorio "${SCRIPTS}/verify-archive.sh" "${archive}" >/dev/null
expect_failure "a factorio archive judged by minecraft's sentinel" \
  env WORLD_NAME=factorio "${SCRIPTS}/verify-archive.sh" "${archive}"

mkdir -p -- "${fixture}/factorio-empty/saves"
expect_failure "archiving a factorio data dir with no save" \
  env SPAWNPOINT_GAME=factorio SERVER_DATA_DIR="${fixture}/factorio-empty" \
    SERVER_BACKUP_DIR="${fixture}/backups" WORLD_NAME=factorio \
    "${SCRIPTS}/archive-world.sh"

# --- releases: the game axis in the manifest, zip mods, and an empty release
#     that still downloads (the vanilla worlds depend on it) ---
mkdir -p -- "${fixture}/bin"
ln -s -- "${REPOSITORY_ROOT}/server/tests/fake-aws" "${fixture}/bin/aws"
export PATH="${fixture}/bin:${PATH}"
export FAKE_S3_ROOT="${fixture}/fake-s3"
export RELEASE_BUCKET="spawnpoint-test-releases"

mkdir -p -- "${fixture}/factorio-pack/mods"
printf 'factorio mod zip bytes\n' >"${fixture}/factorio-pack/mods/example-mod_1.0.0.zip"
printf 'a jar has no business here\n' >"${fixture}/factorio-pack/mods/stray.jar"
RELEASE_GAME=factorio "${SCRIPTS}/build-release-manifest.sh" \
  9.0 2.0.55 factorio "${fixture}/factorio-pack/mods" "${fixture}/factorio-pack/manifest.json" >/dev/null
jq -e '
  .game == "factorio" and
  .loader.type == "factorio" and
  (.server.mods | length == 1) and
  .server.mods[0].file == "example-mod_1.0.0.zip"
' "${fixture}/factorio-pack/manifest.json" >/dev/null

RELEASE_SOURCE_DIR="${fixture}/factorio-pack" \
  "${SCRIPTS}/upload-release.sh" "${fixture}/factorio-pack/manifest.json" >/dev/null
reconcile_output="$(
  RECONCILE_ALLOW_NON_MODS_TARGET=false \
    "${SCRIPTS}/reconcile-release.sh" "${fixture}/factorio-pack/manifest.json" "${fixture}/factorio-live/mods"
)"
grep -qx 'result=reconciled' <<<"${reconcile_output}"
cmp -- "${fixture}/factorio-pack/mods/example-mod_1.0.0.zip" "${fixture}/factorio-live/mods/example-mod_1.0.0.zip"

mkdir -p -- "${fixture}/empty/mods"
RELEASE_GAME=factorio "${SCRIPTS}/build-release-manifest.sh" \
  9.1 2.0.55 factorio "${fixture}/empty/mods" "${fixture}/empty/manifest.json" >/dev/null
RELEASE_SOURCE_DIR="${fixture}/empty" \
  "${SCRIPTS}/upload-release.sh" "${fixture}/empty/manifest.json" >/dev/null
download_output="$("${SCRIPTS}/download-release.sh" 9.1 "${fixture}/cache/9.1")"
grep -qx 'downloaded=0' <<<"${download_output}"
[[ -f "${fixture}/cache/9.1/manifest.json" ]]

expect_failure "an unknown RELEASE_GAME" \
  env RELEASE_GAME=quake "${SCRIPTS}/build-release-manifest.sh" \
  9.2 1.0 x "${fixture}/empty/mods" "${fixture}/empty/never.json"

printf 'game-adapter-test: ok\n'
