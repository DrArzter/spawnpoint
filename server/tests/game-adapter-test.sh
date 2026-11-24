#!/usr/bin/env bash

# The per-game adapter's contract (ADR-0034): a game module is data plus
# functions, minecraft is the byte-identical default, and factorio — the first
# tenant — exercises every axis: another transport, another parser, zip mods,
# zip saves, and an empty release that must still flow through download.

set -Eeuo pipefail

REPOSITORY_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPTS="${REPOSITORY_ROOT}/server/scripts"
GAMES="${REPOSITORY_ROOT}/server/games"
# The shared game_ready default; a module sourced after it may override it.
# shellcheck source=../games/_dispatch.sh
source "${GAMES}/_dispatch.sh"
# shellcheck disable=SC2016 # awk program, not a shell expansion
AWK_ARCHIVE_LINE='$1 == "archive" { print $2 }'
fixture="$(mktemp -d /tmp/spawnpoint-game-adapter-test.XXXXXXXX)"
cleanup() {
  [[ -z "${ready_rcon_pid:-}" ]] || kill "${ready_rcon_pid}" 2>/dev/null || true
  [[ -z "${palworld_rest_pid:-}" ]] || kill "${palworld_rest_pid}" 2>/dev/null || true
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

python3 - "$fixture" <<'READY_RCON' &
import socket, struct, sys

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
server.listen(4)
open(sys.argv[1] + "/ready-rcon-port", "w").write(str(server.getsockname()[1]))

while True:
    conn, _addr = server.accept()
    req_id, _ptype, _body = read(conn)
    conn.sendall(packet(req_id, 2, b""))
    req_id, _ptype, _body = read(conn)
    conn.sendall(packet(req_id, 0, b"Online players (0):"))
    conn.close()
READY_RCON
ready_rcon_pid=$!
for _ in $(seq 1 50); do
  [[ -s "${fixture}/ready-rcon-port" ]] && break
  sleep 0.1
done
ready_rcon_port="$(cat "${fixture}/ready-rcon-port")"

wrong="$(python3 "${GAMES}/_probes/rcon-client.py" 127.0.0.1 "${rcon_port}" "wrong-password" "/players online" 2>&1)" && {
  printf 'expected auth refusal\n' >&2
  exit 1
}
grep -q "authentication refused" <<<"${wrong}"

# A host that is not a loopback address is refused before any connection.
status=0
python3 "${GAMES}/_probes/rcon-client.py" 192.0.2.1 "${rcon_port}" "any" "/time" >/dev/null 2>&1 || status=$?
[[ "${status}" == 2 ]]

response="$(python3 "${GAMES}/_probes/rcon-client.py" 127.0.0.1 "${rcon_port}" "correct-password" "/players online")"
[[ "${response}" == "Online players (0):" ]]
wait "${fake_rcon_pid}"

# Saving is part of the adapter too. The old shared script accidentally sent
# Minecraft's save-all command to every game, which made Factorio stop fail
# before its backup and left the EC2 instance running by design.
python3 - "$fixture" <<'SAVE_RCON' &
import socket, struct, sys

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
server.listen(1)
open(sys.argv[1] + "/save-rcon-port", "w").write(str(server.getsockname()[1]))
conn, _addr = server.accept()
req_id, _ptype, body = read(conn)
assert body == b"correct-password", body
conn.sendall(packet(req_id, 2, b""))
req_id, _ptype, body = read(conn)
open(sys.argv[1] + "/save-rcon-command", "wb").write(body)
conn.sendall(packet(req_id, 0, b"Saving finished"))
conn.close()
server.close()
SAVE_RCON
save_rcon_pid=$!
for _ in $(seq 1 50); do
  [[ -s "${fixture}/save-rcon-port" ]] && break
  sleep 0.1
done
mkdir -p -- "${fixture}/factorio-save/config"
printf 'correct-password\n' >"${fixture}/factorio-save/config/rconpw"
(
  export FACTORIO_DATA_DIR="${fixture}/factorio-save"
  export FACTORIO_RCON_PORT
  FACTORIO_RCON_PORT="$(cat "${fixture}/save-rcon-port")"
  source "${GAMES}/factorio/game.sh"
  [[ "$(game_save)" == "Saving finished" ]]
)
wait "${save_rcon_pid}"
[[ "$(cat "${fixture}/save-rcon-command")" == "/server-save" ]]

(
  : >"${fixture}/minecraft-save-commands"
  source "${GAMES}/minecraft/game.sh"
  rcon() {
    printf '%s\n' "$*" >>"${fixture}/minecraft-save-commands"
    [[ "$*" != "save-all flush" ]] || printf 'Saved the game\n'
  }
  [[ "$(game_save)" == "Saved the game" ]]
  diff -u <(printf 'save-off\nsave-all flush\nsave-on\n') "${fixture}/minecraft-save-commands"
)

# --- dispatch: the catalog names the game, absence means minecraft ---
cat >"${fixture}/catalog.json" <<'EOF'
{"schema_version":1,"profile_source":{"repository":"https://example.invalid/profiles","commit":"0000000000000000000000000000000000000000"},"worlds":[{"id":"factorio","display_name":"Factorio test","profile_id":"factorio-vanilla","game":"factorio"}]}
EOF
output="$(WORLD_ID=factorio SPAWNPOINT_WORLD_CATALOG="${fixture}/catalog.json" bash -c "source '${GAMES}/_dispatch.sh'; resolve_game; printf '%s %s\n' \"\${GAME_ID}\" \"\${GAME_COMPOSE_SERVICE}\"")"
[[ "${output}" == "factorio factorio" ]]
output="$(WORLD_ID=factorio SPAWNPOINT_WORLD_CATALOG="${fixture}/catalog.json" bash -c "source '${GAMES}/_dispatch.sh'; resolve_game; configure_game_compose; printf '%s\n%s\n' \"\${SERVER_COMPOSE_SERVICE}\" \"\${SERVER_COMPOSE_FILES}\"")"
[[ "${output}" == "factorio
${REPOSITORY_ROOT}/server/observability/compose.yaml:${REPOSITORY_ROOT}/server/games/factorio/compose.yaml" ]]
output="$(WORLD_ID=world bash -c "source '${GAMES}/_dispatch.sh'; resolve_game; printf '%s\n' \"\${GAME_ID}\"")"
[[ "${output}" == "minecraft" ]]
output="$(bash -c "source '${GAMES}/_dispatch.sh'; resolve_game; printf '%s\n' \"\${GAME_ID}\"")"
[[ "${output}" == "minecraft" ]]
# The contract: every shipped game defines each required hook, and the arrays
# name only hooks that exist somewhere.
for game in minecraft factorio palworld valheim zomboid; do
  bash -c "source '${GAMES}/_dispatch.sh'; load_game '${game}'; for hook in \"\${GAME_REQUIRED_HOOKS[@]}\"; do declare -F \"\${hook}\" >/dev/null; done"
done
# The header and the README list every hook the arrays name.
for hook in $(bash -c "source '${GAMES}/_dispatch.sh'; printf '%s\n' \"\${GAME_REQUIRED_HOOKS[@]}\" \"\${GAME_OPTIONAL_HOOKS[@]}\""); do
  grep -Eq "^#   ${hook}( |\$)" "${GAMES}/_dispatch.sh" || { printf 'header does not describe %s\n' "${hook}" >&2; exit 1; }
  grep -Fq "${hook}" "${GAMES}/README.md" || { printf 'README does not describe %s\n' "${hook}" >&2; exit 1; }
done
# A module that lacks a required hook is refused with a message, not exit 127.
mkdir -p "${fixture}/contract/games/broken"
cp "${GAMES}/_dispatch.sh" "${GAMES}/_legacy-game.sh" "${fixture}/contract/games/"
cat >"${fixture}/contract/games/broken/game.sh" <<'BROKEN'
GAME_COMPOSE_SERVICE="broken"
game_query_players_raw() { :; }
game_parse_player_count() { :; }
BROKEN
status=0
message="$(LEGACY_GAME_ID=broken bash -c "source '${fixture}/contract/games/_dispatch.sh'; load_game broken" 2>&1)" || status=$?
[[ "${status}" == "1" ]]
[[ "${message}" == "error: game broken does not implement required hooks: game_save game_save_paths game_save_sentinel game_archive_sentinel_regex game_tick_time_ms" ]]
expect_failure "a world naming a game with no module" \
  env SPAWNPOINT_GAME=heroes-of-might bash -c "source '${GAMES}/_dispatch.sh'; resolve_game"

# world-profile reports the axis
profile_output="$(SPAWNPOINT_WORLD_CATALOG="${fixture}/catalog.json" "${SCRIPTS}/world-profile.sh" factorio)"
grep -qx 'game=factorio' <<<"${profile_output}"

# --- minecraft saves: a world created from a preset has an id such as
#     minecraft-rostik-1a2b3c4d, and the server keeps its save in the level
#     folder compose pins. The id names the backup, never the folder. ---
mc_world="minecraft-rostik-1a2b3c4d"
mkdir -p -- "${fixture}/mc-data/world/region" "${fixture}/mc-data/world_nether" "${fixture}/mc-backups"
printf 'level bytes\n' >"${fixture}/mc-data/world/level.dat"
printf 'nether bytes\n' >"${fixture}/mc-data/world_nether/marker"
mc_output="$(
  SPAWNPOINT_GAME=minecraft \
  SERVER_DATA_DIR="${fixture}/mc-data" \
  SERVER_BACKUP_DIR="${fixture}/mc-backups" \
  WORLD_NAME="${mc_world}" \
    "${SCRIPTS}/archive-world.sh"
)"
mc_archive="$(awk -F= "${AWK_ARCHIVE_LINE}" <<<"${mc_output}")"
[[ "$(basename -- "${mc_archive}")" == "${mc_world}-"*.tar.zst ]]
mc_listing="$(tar --list --zstd --file "${mc_archive}")"
grep -qx 'world/level.dat' <<<"${mc_listing}"
grep -qx 'world_nether/marker' <<<"${mc_listing}"
WORLD_NAME="${mc_world}" "${SCRIPTS}/verify-archive.sh" "${mc_archive}" >/dev/null
WORLD_NAME="${mc_world}" "${SCRIPTS}/restore-world.sh" "${mc_archive}" "${fixture}/mc-restored" >/dev/null
cmp -- "${fixture}/mc-data/world/level.dat" "${fixture}/mc-restored/world/level.dat"

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
archive="$(awk -F= "${AWK_ARCHIVE_LINE}" <<<"${archive_output}")"
listing="$(tar --list --zstd --file "${archive}")"
grep -qx 'saves/spawnpoint.zip' <<<"${listing}"

SPAWNPOINT_GAME=factorio WORLD_NAME=factorio "${SCRIPTS}/verify-archive.sh" "${archive}" >/dev/null
expect_failure "a factorio archive judged by minecraft's sentinel" \
  env WORLD_NAME=factorio "${SCRIPTS}/verify-archive.sh" "${archive}"

SPAWNPOINT_GAME=factorio WORLD_NAME=factorio \
  "${SCRIPTS}/restore-world.sh" "${archive}" "${fixture}/factorio-restored" >/dev/null
cmp -- "${fixture}/factorio-data/saves/spawnpoint.zip" "${fixture}/factorio-restored/saves/spawnpoint.zip"

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
export RELEASE_PROFILE_ID="adapter-test"
export RELEASE_PROFILE_REPOSITORY="https://github.com/example/config"
export RELEASE_PROFILE_COMMIT="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

mkdir -p -- "${fixture}/factorio-pack/mods"
printf 'factorio mod zip bytes\n' >"${fixture}/factorio-pack/mods/example-mod_1.0.0.zip"
printf 'a jar has no business here\n' >"${fixture}/factorio-pack/mods/stray.jar"
RELEASE_GAME=factorio \
RELEASE_RUNTIME_IMAGE=registry.example.invalid/factorio:9.9.9@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
  "${SCRIPTS}/build-release-manifest.sh" \
  9.0 2.0.55 2.0.55 "${fixture}/factorio-pack/mods" "${fixture}/factorio-pack/manifest.json" >/dev/null
jq -e '
  .game == "factorio" and
  .runtime.image == "registry.example.invalid/factorio:9.9.9@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" and
  .loader.type == "factorio" and
  (.server.mods | length == 1) and
  .server.mods[0].file == "example-mod_1.0.0.zip"
' "${fixture}/factorio-pack/manifest.json" >/dev/null

# The runtime image is selected from the same verified manifest as the mods;
# a mismatched loader version cannot silently boot a different engine.
(
  source "${GAMES}/factorio/game.sh"
  game_prepare_runtime "${fixture}/factorio-pack/manifest.json"
  [[ "${SPAWNPOINT_GAME_IMAGE}" == "registry.example.invalid/factorio:9.9.9@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" ]]
)
mkdir -p -- "${fixture}/factorio-installed"
cp -- "${fixture}/factorio-pack/manifest.json" "${fixture}/factorio-installed/.spawnpoint-release.json"
(
  unset SPAWNPOINT_GAME_IMAGE
  export SPAWNPOINT_WORLD_MODS_DIRECTORY="${fixture}/factorio-installed"
  source "${GAMES}/factorio/game.sh"
  source "${GAMES}/_dispatch.sh"
  prepare_game_runtime
  [[ "${SPAWNPOINT_GAME_IMAGE}" == "registry.example.invalid/factorio:9.9.9@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" ]]
)
jq '.loader.version = "2.0.54"' "${fixture}/factorio-pack/manifest.json" >"${fixture}/factorio-pack/mismatched-manifest.json"
expect_failure "a factorio runtime whose manifest disagrees with its loader" \
  bash -c "source '${GAMES}/factorio/game.sh'; game_prepare_runtime '${fixture}/factorio-pack/mismatched-manifest.json'"

RELEASE_SOURCE_DIR="${fixture}/factorio-pack" \
  "${SCRIPTS}/upload-release.sh" "${fixture}/factorio-pack/manifest.json" >/dev/null
reconcile_output="$(
  RECONCILE_ALLOW_NON_MODS_TARGET=false \
    "${SCRIPTS}/reconcile-release.sh" "${fixture}/factorio-pack/manifest.json" "${fixture}/factorio-live/mods"
)"
grep -qx 'result=reconciled' <<<"${reconcile_output}"
cmp -- "${fixture}/factorio-pack/mods/example-mod_1.0.0.zip" "${fixture}/factorio-live/mods/example-mod_1.0.0.zip"

mkdir -p -- "${fixture}/empty/mods"
RELEASE_GAME=factorio \
RELEASE_RUNTIME_IMAGE=registry.example.invalid/factorio:9.9.9@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
  "${SCRIPTS}/build-release-manifest.sh" \
  9.1 2.0.55 2.0.55 "${fixture}/empty/mods" "${fixture}/empty/manifest.json" >/dev/null
RELEASE_SOURCE_DIR="${fixture}/empty" \
  "${SCRIPTS}/upload-release.sh" "${fixture}/empty/manifest.json" >/dev/null
download_output="$("${SCRIPTS}/download-release.sh" factorio adapter-test 9.1 "${fixture}/cache/9.1")"
grep -qx 'downloaded=0' <<<"${download_output}"
[[ -f "${fixture}/cache/9.1/manifest.json" ]]

RELEASE_GAME=zomboid "${SCRIPTS}/build-release-manifest.sh" \
  9.2 42.20 42.20 "${fixture}/empty/mods" "${fixture}/empty/zomboid-manifest.json" >/dev/null
RELEASE_SOURCE_DIR="${fixture}/empty" \
  "${SCRIPTS}/upload-release.sh" "${fixture}/empty/zomboid-manifest.json" >/dev/null
[[ -f "${FAKE_S3_ROOT}/${RELEASE_BUCKET}/releases/zomboid/adapter-test/9.2/manifest.json" ]]
[[ -f "${FAKE_S3_ROOT}/${RELEASE_BUCKET}/releases/zomboid/adapter-test/9.2/client.zip" ]]

expect_failure "an unknown RELEASE_GAME" \
  env RELEASE_GAME=quake "${SCRIPTS}/build-release-manifest.sh" \
  9.3 1.0 x "${fixture}/empty/mods" "${fixture}/empty/never.json"

# --- readiness: the last minecraft assumption in the start path, now the
#     module's call. Minecraft's control path is stubbed; factorio's is the real
#     RCON round trip against the fake server above. ---
(
  source "${GAMES}/minecraft/game.sh"
  rcon() { printf 'There are 0 of a max of 20 players online:\n'; }
  game_ready none
  game_ready healthy
  if game_ready unhealthy; then exit 1; fi
  if game_ready starting; then exit 1; fi
  rcon() { return 1; }
  if game_ready healthy; then exit 1; fi
)
(
  export FACTORIO_DATA_DIR="${fixture}/ready-data"
  export FACTORIO_RCON_PORT="${ready_rcon_port}"
  mkdir -p -- "${FACTORIO_DATA_DIR}/config"
  source "${GAMES}/factorio/game.sh"
  # No password file yet: the server has not booted, so it cannot be ready.
  if game_ready none; then exit 1; fi
  printf 'correct-password\n' >"${FACTORIO_DATA_DIR}/config/rconpw"
  game_ready none
  if game_ready unhealthy; then exit 1; fi
)

# --- zomboid: the parser refuses to trust an undocumented wording, the world
#     is two directories, and the release path is deliberately absent ---
(
  source "${GAMES}/zomboid/game.sh"
  [[ "$(game_parse_player_count <<<'Players connected (0):')" == "0" ]]
  [[ "$(game_parse_player_count <<<'Players connected (2):
-Alice
-Bob')" == "2" ]]
  # A header that disagrees with the names listed is a wording this parser does
  # not actually understand, and reporting a count from it would report an empty
  # server that is not empty.
  if game_parse_player_count <<<'Players connected (2):
-Alice' >/dev/null 2>&1; then exit 1; fi
  if game_parse_player_count <<<'There are 2 of a max of 20 players online: a, b' >/dev/null 2>&1; then exit 1; fi
  if game_parse_player_count <<<'Online players (1):' >/dev/null 2>&1; then exit 1; fi
)

# The server names its own save directory, so the module must not assume it:
# "servertest" is the name the game uses when nobody sets one.
zomboid_world="${fixture}/zomboid-data"
mkdir -p -- "${zomboid_world}/Saves/Multiplayer/servertest" "${zomboid_world}/db"
printf 'chunk\n' >"${zomboid_world}/Saves/Multiplayer/servertest/map_10_20.bin"
printf 'sqlite\n' >"${zomboid_world}/Saves/Multiplayer/servertest/players.db"
printf 'accounts\n' >"${zomboid_world}/db/servertest.db"
(
  source "${GAMES}/zomboid/game.sh"
  # Any world id finds the save, because the save's name belongs to the server.
  game_save_sentinel "${zomboid_world}" zomboid
  game_save_sentinel "${zomboid_world}" whatever-the-catalog-calls-it
  paths="$(game_save_paths "${zomboid_world}" zomboid | tr '\0' ' ')"
  [[ "${paths}" == "Saves db " ]]

  # An empty Saves tree is not a save, and the accounts database alone is not
  # either: restoring that would be players with no world.
  mkdir -p -- "${fixture}/zomboid-empty/Saves/Multiplayer" "${fixture}/zomboid-empty/db"
  printf 'accounts\n' >"${fixture}/zomboid-empty/db/servertest.db"
  if game_save_sentinel "${fixture}/zomboid-empty" zomboid; then exit 1; fi

  # The password comes from the environment the image is given, not from a file.
  export ZOMBOID_RCON_PASSWORD="from-env"
  [[ "$(zomboid_rcon_password)" == "from-env" ]]
  unset ZOMBOID_RCON_PASSWORD
  printf 'ZOMBOID_RCON_PASSWORD=from-file\n' >"${fixture}/zomboid.env"
  [[ "$(SERVER_ENV_FILE="${fixture}/zomboid.env" zomboid_rcon_password)" == "from-file" ]]
  if SERVER_ENV_FILE="${fixture}/missing.env" zomboid_rcon_password 2>/dev/null; then exit 1; fi
)

zomboid_archive_output="$(
  SPAWNPOINT_GAME=zomboid \
  SERVER_DATA_DIR="${zomboid_world}" \
  SERVER_BACKUP_DIR="${fixture}/backups" \
  WORLD_NAME=zomboid \
    "${SCRIPTS}/archive-world.sh"
)"
zomboid_archive="$(awk -F= "${AWK_ARCHIVE_LINE}" <<<"${zomboid_archive_output}")"
zomboid_listing="$(tar --list --zstd --file "${zomboid_archive}")"
grep -qx 'Saves/Multiplayer/servertest/map_10_20.bin' <<<"${zomboid_listing}"
grep -qx 'Saves/Multiplayer/servertest/players.db' <<<"${zomboid_listing}"
grep -qx 'db/servertest.db' <<<"${zomboid_listing}"
SPAWNPOINT_GAME=zomboid WORLD_NAME=zomboid "${SCRIPTS}/verify-archive.sh" "${zomboid_archive}" >/dev/null
expect_failure "a zomboid archive judged by another game's sentinel" \
  env SPAWNPOINT_GAME=factorio WORLD_NAME=zomboid "${SCRIPTS}/verify-archive.sh" "${zomboid_archive}"

SPAWNPOINT_GAME=zomboid WORLD_NAME=zomboid \
  "${SCRIPTS}/restore-world.sh" "${zomboid_archive}" "${fixture}/zomboid-restored" >/dev/null
diff -r -- "${zomboid_world}/Saves" "${fixture}/zomboid-restored/Saves"
diff -r -- "${zomboid_world}/db" "${fixture}/zomboid-restored/db"

# Workshop ids are not bytes, so the vanilla release tested above deliberately
# carries an empty payload. A future Workshop resolver owns that translation.

# The console (ADR-0063) speaks to the slot's RCON port. Every entry script
# loads the game before configure_game_compose exports the slot's ports, so the
# port must be read when the command is sent, not when the module loads.
python3 - "$fixture" <<'CONSOLE_RCON' &
import socket, struct, sys

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
server.listen(1)
open(sys.argv[1] + "/console-rcon-port", "w").write(str(server.getsockname()[1]))
conn, _addr = server.accept()
req_id, _ptype, body = read(conn)
assert body == b"correct-password", body
conn.sendall(packet(req_id, 2, b""))
req_id, _ptype, body = read(conn)
open(sys.argv[1] + "/console-rcon-command", "wb").write(body)
conn.sendall(packet(req_id, 0, b"Alice (online)"))
CONSOLE_RCON
console_rcon_pid=$!
for _ in $(seq 1 50); do
  [[ -s "${fixture}/console-rcon-port" ]] && break
  sleep 0.1
done
(
  unset FACTORIO_RCON_PORT SPAWNPOINT_PROBE_PORT
  export FACTORIO_DATA_DIR="${fixture}/factorio-save"
  source "${GAMES}/factorio/game.sh"
  # What configure_game_compose does for a slot, after the module has loaded.
  export SPAWNPOINT_PROBE_PORT
  SPAWNPOINT_PROBE_PORT="$(cat "${fixture}/console-rcon-port")"
  [[ "$(game_console "/players online")" == "Alice (online)" ]]
)
wait "${console_rcon_pid}"
[[ "$(cat "${fixture}/console-rcon-command")" == "/players online" ]]

# --- valheim: the A2S probe (ADR-0075), a two-file save, and no console ---
(
  source "${GAMES}/valheim/game.sh"
  [[ "$(game_parse_player_count <<<'info_players=0
info_max_players=10
info_bots=0
player_entries=0')" == "0" ]]
  [[ "$(game_parse_player_count <<<'info_players=2
info_max_players=10
info_bots=0
player_entries=2')" == "2" ]]
  # A count the list does not bear out is refused, never read as empty.
  if game_parse_player_count <<<'info_players=2
info_max_players=10
info_bots=0
player_entries=0' >/dev/null 2>&1; then exit 1; fi
  if game_parse_player_count <<<'Players connected (0):' >/dev/null 2>&1; then exit 1; fi
  if game_parse_player_count <<<'Online players (0):' >/dev/null 2>&1; then exit 1; fi
  # Another game's parser does not read this one's reply either.
  source "${GAMES}/zomboid/game.sh"
  if game_parse_player_count <<<'info_players=0
info_bots=0
player_entries=0' >/dev/null 2>&1; then exit 1; fi
)
(
  source "${GAMES}/valheim/game.sh"
  load_game_facts "${GAMES}/valheim/game.json"
  [[ "${GAME_CONNECT_PORT}" == "2456" && "${GAME_CONNECT_PROTOCOL}" == "udp" ]]
  [[ "${GAME_PROBE_PORT}" == "$((GAME_CONNECT_PORT + 1))" ]]
  [[ "${GAME_DEFAULT_AUTH}" == "none" ]]
  if declare -F game_console >/dev/null; then exit 1; fi
  status=0
  game_tick_time_ms 2>/dev/null || status=$?
  [[ "${status}" == 2 ]]
  [[ "$(game_save)" == "save_deferred=graceful_shutdown" ]]
)

# The probe speaks to the slot's query port, read when it runs: every entry
# script loads the game before configure_game_compose exports the slot's ports.
python3 - "$fixture" <<'VALHEIM_A2S' &
import socket, struct, sys
HEADER = b"\xff\xff\xff\xff"
server = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
server.bind(("127.0.0.1", 0))
open(sys.argv[1] + "/valheim-a2s-port", "w").write(str(server.getsockname()[1]))
while True:
    data, peer = server.recvfrom(2048)
    if data[4:5] == b"T":
        body = b"I\x11Spawnpoint\x00spawnpoint\x00valheim\x00Valheim\x00" + struct.pack("<h", 0)
        server.sendto(HEADER + body + bytes([1, 10, 0]) + b"dl\x01\x00" + b"1.0\x00", peer)
    elif data[5:] != b"\x01\x02\x03\x04":
        server.sendto(HEADER + b"A\x01\x02\x03\x04", peer)
    else:
        server.sendto(HEADER + b"D\x01" + b"\x00Viking\x00" + struct.pack("<if", 0, 1.0), peer)
VALHEIM_A2S
valheim_a2s_pid=$!
for _ in $(seq 1 50); do
  [[ -s "${fixture}/valheim-a2s-port" ]] && break
  sleep 0.1
done
(
  unset VALHEIM_QUERY_PORT SPAWNPOINT_PROBE_PORT
  source "${GAMES}/valheim/game.sh"
  export SPAWNPOINT_PROBE_PORT
  SPAWNPOINT_PROBE_PORT="$(cat "${fixture}/valheim-a2s-port")"
  [[ "$(game_query_players_raw | game_parse_player_count)" == "1" ]]
  game_ready none
  game_ready healthy
  if game_ready unhealthy; then exit 1; fi
  # Nothing answers on this port: not ready, and no count.
  SPAWNPOINT_PROBE_PORT="$(python3 -c 'import socket; s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')"
  if game_ready none; then exit 1; fi
)
kill "${valheim_a2s_pid}" 2>/dev/null || true
wait "${valheim_a2s_pid}" 2>/dev/null || true

# Dispatch through the catalog, and the files a session runs.
cat >"${fixture}/valheim-catalog.json" <<'EOF'
{"schema_version":1,"profile_source":{"repository":"https://example.invalid/profiles","commit":"0000000000000000000000000000000000000000"},"worlds":[{"id":"valheim","display_name":"Valheim test","profile_id":"valheim-vanilla","game":"valheim"}]}
EOF
output="$(WORLD_ID=valheim SPAWNPOINT_WORLD_CATALOG="${fixture}/valheim-catalog.json" bash -c "source '${GAMES}/_dispatch.sh'; resolve_game; configure_game_compose; printf '%s\n%s\n%s\n' \"\${GAME_ID}\" \"\${SERVER_COMPOSE_SERVICE}\" \"\${SERVER_COMPOSE_FILES}\"")"
[[ "${output}" == "valheim
valheim
${REPOSITORY_ROOT}/server/observability/compose.yaml:${REPOSITORY_ROOT}/server/games/valheim/compose.yaml" ]]
output="$(WORLD_ID=valheim WORLD_FOOTPRINT_MEMORY_MIB=4096 SPAWNPOINT_SLOT=3 SPAWNPOINT_WORLD_CATALOG="${fixture}/valheim-catalog.json" bash -c "source '${GAMES}/_dispatch.sh'; resolve_game; configure_game_compose; printf '%s %s %s\n' \"\${SPAWNPOINT_GAME_PORT}\" \"\${SPAWNPOINT_PROBE_PORT}\" \"\${SERVER_COMPOSE_FILES}\"")"
[[ "${output}" == "30030 30031 ${REPOSITORY_ROOT}/server/games/valheim/compose.yaml:${REPOSITORY_ROOT}/server/games/valheim/compose.footprint.yaml" ]]

# The save is the world's two files, named by the server's own setting and
# never by the world's id, with the lists that belong to the world.
valheim_world="${fixture}/valheim-data"
mkdir -p -- "${valheim_world}/worlds_local" "${valheim_world}/backups"
printf 'seed\n' >"${valheim_world}/worlds_local/spawnpoint.fwl"
printf 'buildings\n' >"${valheim_world}/worlds_local/spawnpoint.db"
printf 'previous\n' >"${valheim_world}/worlds_local/spawnpoint.db.old"
printf '// List admin players ID  ONE per line\n' >"${valheim_world}/adminlist.txt"
printf '// List banned players ID  ONE per line\n' >"${valheim_world}/bannedlist.txt"
printf 'an image backup\n' >"${valheim_world}/backups/worlds-20261121.zip"
(
  source "${GAMES}/valheim/game.sh"
  game_save_sentinel "${valheim_world}" valheim
  game_save_sentinel "${valheim_world}" valheim-rostik-1a2b3c4d
  paths="$(game_save_paths "${valheim_world}" valheim | tr '\0' ' ')"
  [[ "${paths}" == "worlds_local adminlist.txt bannedlist.txt " ]]

  # Either file alone restores a different world, so neither is a save.
  mkdir -p -- "${fixture}/valheim-half/worlds_local"
  printf 'seed\n' >"${fixture}/valheim-half/worlds_local/spawnpoint.fwl"
  if game_save_sentinel "${fixture}/valheim-half" valheim; then exit 1; fi
  rm -- "${fixture}/valheim-half/worlds_local/spawnpoint.fwl"
  printf 'buildings\n' >"${fixture}/valheim-half/worlds_local/spawnpoint.db"
  if game_save_sentinel "${fixture}/valheim-half" valheim; then exit 1; fi
  # A world of another name is not this server's save.
  mkdir -p -- "${fixture}/valheim-other/worlds_local"
  printf 'seed\n' >"${fixture}/valheim-other/worlds_local/Dedicated.fwl"
  printf 'buildings\n' >"${fixture}/valheim-other/worlds_local/Dedicated.db"
  if game_save_sentinel "${fixture}/valheim-other" valheim; then exit 1; fi
)

valheim_archive_output="$(
  SPAWNPOINT_GAME=valheim \
  SERVER_DATA_DIR="${valheim_world}" \
  SERVER_BACKUP_DIR="${fixture}/backups" \
  WORLD_NAME=valheim \
    "${SCRIPTS}/archive-world.sh"
)"
valheim_archive="$(awk -F= "${AWK_ARCHIVE_LINE}" <<<"${valheim_archive_output}")"
valheim_listing="$(tar --list --zstd --file "${valheim_archive}")"
grep -qx 'worlds_local/spawnpoint.fwl' <<<"${valheim_listing}"
grep -qx 'worlds_local/spawnpoint.db' <<<"${valheim_listing}"
grep -qx 'adminlist.txt' <<<"${valheim_listing}"
if grep -q '^backups' <<<"${valheim_listing}"; then exit 1; fi
SPAWNPOINT_GAME=valheim WORLD_NAME=valheim "${SCRIPTS}/verify-archive.sh" "${valheim_archive}" >/dev/null
expect_failure "a valheim archive judged by another game's sentinel" \
  env SPAWNPOINT_GAME=zomboid WORLD_NAME=valheim "${SCRIPTS}/verify-archive.sh" "${valheim_archive}"
expect_failure "a factorio archive judged by valheim's sentinel" \
  env SPAWNPOINT_GAME=valheim WORLD_NAME=factorio "${SCRIPTS}/verify-archive.sh" "${archive}"
SPAWNPOINT_GAME=valheim WORLD_NAME=valheim \
  "${SCRIPTS}/restore-world.sh" "${valheim_archive}" "${fixture}/valheim-restored" >/dev/null
diff -r -- "${valheim_world}/worlds_local" "${fixture}/valheim-restored/worlds_local"
cmp -- "${valheim_world}/adminlist.txt" "${fixture}/valheim-restored/adminlist.txt"
expect_failure "archiving a valheim data dir with half a save" \
  env SPAWNPOINT_GAME=valheim SERVER_DATA_DIR="${fixture}/valheim-half" \
    SERVER_BACKUP_DIR="${fixture}/backups" WORLD_NAME=valheim \
    "${SCRIPTS}/archive-world.sh"

# --- palworld: the REST API (ADR-0076) for the count, the save and the console ---
(
  source "${GAMES}/palworld/game.sh"
  [[ "$(game_parse_player_count <<<'current_players=0
max_players=32
listed_players=0')" == "0" ]]
  [[ "$(game_parse_player_count <<<'current_players=3
max_players=32
listed_players=3')" == "3" ]]
  # A count the list does not bear out is refused, never read as empty.
  for raw in \
    'current_players=2
max_players=32
listed_players=0' \
    'current_players=0
max_players=32
listed_players=1' \
    'current_players=0
current_players=0
listed_players=0' \
    'current_players=0' \
    'listed_players=0' \
    'current_players=-1
listed_players=-1' \
    'info_players=0
info_bots=0
player_entries=0' \
    'Players connected (0):' \
    ''; do
    if game_parse_player_count <<<"${raw}" >/dev/null 2>&1; then
      printf 'palworld: expected refusal: %s\n' "${raw}" >&2
      exit 1
    fi
  done
  # Another game's parser does not read this one's reply either.
  source "${GAMES}/valheim/game.sh"
  if game_parse_player_count <<<'current_players=0
listed_players=0' >/dev/null 2>&1; then exit 1; fi
)
(
  source "${GAMES}/palworld/game.sh"
  load_game_facts "${GAMES}/palworld/game.json"
  [[ "${GAME_CONNECT_PORT}" == "8211" && "${GAME_CONNECT_PROTOCOL}" == "udp" ]]
  [[ "${GAME_PROBE_PORT}" == "8212" && "${GAME_SLOTTABLE}" == "true" ]]
  [[ "${GAME_DEFAULT_AUTH}" == "none" ]]
  # The documented footprint, not one shrunk to fit a host.
  [[ "${GAME_FOOTPRINT_MEMORY_MIB}" == "16384" ]]
  for member in game_ready game_query_players_raw game_parse_player_count game_console game_save \
    game_save_paths game_save_sentinel game_archive_sentinel_regex game_tick_time_ms; do
    declare -F "${member}" >/dev/null || { printf 'palworld lacks %s\n' "${member}" >&2; exit 1; }
  done
)

# A fake REST API with basic authentication. The scenario file says what it
# answers; the request log says what reached it.
cat >"${fixture}/fake-palworld.py" <<'FAKE_PALWORLD'
import base64, http.server, json, sys

directory = sys.argv[1]
EXPECTED = "Basic " + base64.b64encode(b"admin:pal-secret").decode()
PLAYER = {"name": "Lamball fan", "accountName": "fan", "playerId": "0" * 32, "userId": "steam_00000000000000000",
          "ip": "192.0.2.10", "ping": 20.0, "location_x": 0.0, "location_y": 0.0, "level": 3, "building_count": 1}

class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def answer(self, status, body=b""):
        self.send_response(status)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def route(self, method):
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length).decode() if length else ""
        with open(directory + "/palworld-requests", "a") as log:
            log.write(f"{method} {self.path} {body}\n")
        if self.headers.get("Authorization") != EXPECTED:
            return self.answer(401)
        scenario = open(directory + "/palworld-scenario").read().split()
        current, listed, shape = int(scenario[0]), int(scenario[1]), scenario[2]
        if method == "GET" and self.path == "/v1/api/metrics":
            metrics = {"serverfps": 60, "currentplayernum": current, "serverframetime": 16.6667,
                       "maxplayernum": 32, "uptime": 120, "basecampnum": 0, "days": 1}
            if shape == "nometrics":
                metrics.pop("currentplayernum")
            return self.answer(200, json.dumps(metrics).encode())
        if method == "GET" and self.path == "/v1/api/players":
            if shape == "noplayers":
                return self.answer(200, b'{"error":"busy"}')
            return self.answer(200, json.dumps({"players": [PLAYER] * listed}).encode())
        if method == "GET" and self.path == "/v1/api/info":
            return self.answer(200, b'{"version":"v0.0.0","servername":"Spawnpoint","description":"","worldguid":"' + b"A" * 32 + b'"}')
        if method == "POST" and self.path == "/v1/api/save":
            return self.answer(500 if shape == "savefails" else 200)
        if method == "POST" and self.path == "/v1/api/announce":
            return self.answer(200)
        return self.answer(404)

    def do_GET(self):
        self.route("GET")

    def do_POST(self):
        self.route("POST")

server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
open(directory + "/palworld-port", "w").write(str(server.server_address[1]))
server.serve_forever()
FAKE_PALWORLD
printf '2 2 good\n' >"${fixture}/palworld-scenario"
python3 "${fixture}/fake-palworld.py" "${fixture}" &
palworld_rest_pid=$!
for _ in $(seq 1 50); do
  [[ -s "${fixture}/palworld-port" ]] && break
  sleep 0.1
done
(
  unset PALWORLD_REST_PORT SPAWNPOINT_PROBE_PORT PALWORLD_ADMIN_PASSWORD
  # The password comes from the host's runtime .env, as compose reads it.
  printf 'PALWORLD_ADMIN_PASSWORD=pal-secret\n' >"${fixture}/palworld.env"
  export SERVER_ENV_FILE="${fixture}/palworld.env"
  source "${GAMES}/palworld/game.sh"
  # The probe reads the slot's port when it runs, after the module has loaded.
  export SPAWNPOINT_PROBE_PORT
  SPAWNPOINT_PROBE_PORT="$(cat "${fixture}/palworld-port")"

  raw="$(game_query_players_raw)"
  [[ "${raw}" == "current_players=2
max_players=32
listed_players=2" ]]
  # Counts only: no name, account, id or address leaves the transport.
  if grep -Eq 'Lamball|fan|steam_|192\.0\.2' <<<"${raw}"; then exit 1; fi
  [[ "$(game_parse_player_count <<<"${raw}")" == "2" ]]
  game_ready healthy
  game_ready none
  if game_ready unhealthy; then exit 1; fi

  # The two readings disagree: the transport reports both, the parser refuses.
  printf '2 1 good\n' >"${fixture}/palworld-scenario"
  raw="$(game_query_players_raw)"
  if game_parse_player_count <<<"${raw}" >/dev/null 2>&1; then exit 1; fi
  if game_ready none; then exit 1; fi
  # A reply of another shape is not understood, and never a count.
  for shape in nometrics noplayers; do
    printf '0 0 %s\n' "${shape}" >"${fixture}/palworld-scenario"
    status=0
    game_query_players_raw >/dev/null 2>&1 || status=$?
    [[ "${status}" == 4 ]] || { printf 'palworld shape %s: status %s\n' "${shape}" "${status}" >&2; exit 1; }
  done
  printf '0 0 good\n' >"${fixture}/palworld-scenario"
  [[ "$(game_query_players_raw | game_parse_player_count)" == "0" ]]

  # The save is the API's save call, and its failure is the save's failure.
  [[ "$(game_save)" == "save=rest_api" ]]
  grep -Fxq 'POST /v1/api/save ' "${fixture}/palworld-requests"
  printf '0 0 savefails\n' >"${fixture}/palworld-scenario"
  if game_save >/dev/null 2>&1; then exit 1; fi
  printf '0 0 good\n' >"${fixture}/palworld-scenario"

  [[ "$(game_tick_time_ms)" == "16.6667" ]]

  # The console speaks the API's words; the message travels as JSON.
  [[ "$(game_console metrics)" == *'"currentplayernum": 0'* ]]
  [[ "$(game_console info)" == *'"servername":"Spawnpoint"'* ]]
  [[ "$(game_console save)" == "saved" ]]
  [[ "$(game_console 'announce Server stops "soon" in 5 minutes')" == "announced" ]]
  grep -Fxq 'POST /v1/api/announce {"message":"Server stops \"soon\" in 5 minutes"}' "${fixture}/palworld-requests"
  [[ "$(game_console 'announce')" == "usage: announce <message>" ]]
  [[ "$(game_console 'shutdown 1')" == "unknown command: shutdown"* ]]
  [[ "$(game_console 'stop')" == "unknown command: stop"* ]]
  if grep -Eq '/v1/api/(shutdown|stop)' "${fixture}/palworld-requests"; then exit 1; fi

  # A wrong password is refused by the server, and that is no answer to count.
  printf 'PALWORLD_ADMIN_PASSWORD=wrong\n' >"${fixture}/palworld.env"
  if game_query_players_raw >/dev/null 2>&1; then exit 1; fi
  # No password at all is refused before any request.
  : >"${fixture}/palworld.env"
  status=0
  game_query_players_raw >/dev/null 2>&1 || status=$?
  [[ "${status}" == 2 ]]
  # Nothing answers on this port: not ready, and no count.
  printf 'PALWORLD_ADMIN_PASSWORD=pal-secret\n' >"${fixture}/palworld.env"
  SPAWNPOINT_PROBE_PORT="$(python3 -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')"
  if game_ready none; then exit 1; fi
)
kill "${palworld_rest_pid}" 2>/dev/null || true
wait "${palworld_rest_pid}" 2>/dev/null || true

# The console script answers through the module, with the port of the slot.
cat >"${fixture}/palworld-catalog.json" <<'EOF'
{"schema_version":1,"profile_source":{"repository":"https://example.invalid/profiles","commit":"0000000000000000000000000000000000000000"},"worlds":[{"id":"palworld","display_name":"Palworld test","profile_id":"palworld-vanilla","game":"palworld"}]}
EOF
output="$(WORLD_ID=palworld SPAWNPOINT_WORLD_CATALOG="${fixture}/palworld-catalog.json" bash -c "source '${GAMES}/_dispatch.sh'; resolve_game; configure_game_compose; printf '%s\n%s\n%s\n' \"\${GAME_ID}\" \"\${SERVER_COMPOSE_SERVICE}\" \"\${SERVER_COMPOSE_FILES}\"")"
[[ "${output}" == "palworld
palworld
${REPOSITORY_ROOT}/server/observability/compose.yaml:${REPOSITORY_ROOT}/server/games/palworld/compose.yaml" ]]
output="$(WORLD_ID=palworld WORLD_FOOTPRINT_MEMORY_MIB=16384 SPAWNPOINT_SLOT=2 SPAWNPOINT_WORLD_CATALOG="${fixture}/palworld-catalog.json" bash -c "source '${GAMES}/_dispatch.sh'; resolve_game; configure_game_compose; printf '%s %s %s\n' \"\${SPAWNPOINT_GAME_PORT}\" \"\${SPAWNPOINT_PROBE_PORT}\" \"\${SERVER_COMPOSE_FILES}\"")"
[[ "${output}" == "30020 30021 ${REPOSITORY_ROOT}/server/games/palworld/compose.yaml:${REPOSITORY_ROOT}/server/games/palworld/compose.footprint.yaml" ]]

# The save is the world GameUserSettings.ini names, with that file, and never
# the rendered PalWorldSettings.ini, which holds the admin password.
palworld_guid="0123456789ABCDEF0123456789ABCDEF"
palworld_world="${fixture}/palworld-data"
mkdir -p -- "${palworld_world}/SaveGames/0/${palworld_guid}/Players" "${palworld_world}/Config/LinuxServer" "${palworld_world}/Logs"
printf 'level\n' >"${palworld_world}/SaveGames/0/${palworld_guid}/Level.sav"
printf 'meta\n' >"${palworld_world}/SaveGames/0/${palworld_guid}/LevelMeta.sav"
printf 'player\n' >"${palworld_world}/SaveGames/0/${palworld_guid}/Players/00000000000000000000000000000001.sav"
printf '[/Script/Pal.PalGameLocalSettings]\nDedicatedServerName=%s\n' "${palworld_guid}" \
  >"${palworld_world}/Config/LinuxServer/GameUserSettings.ini"
printf '[/Script/Pal.PalGameWorldSettings]\nOptionSettings=(AdminPassword="not-for-backups")\n' \
  >"${palworld_world}/Config/LinuxServer/PalWorldSettings.ini"
printf 'log\n' >"${palworld_world}/Logs/Pal.log"
(
  source "${GAMES}/palworld/game.sh"
  game_save_sentinel "${palworld_world}" palworld
  game_save_sentinel "${palworld_world}" palworld-rostik-1a2b3c4d
  paths="$(game_save_paths "${palworld_world}" palworld | tr '\0' ' ')"
  [[ "${paths}" == "SaveGames Config/LinuxServer/GameUserSettings.ini " ]]

  # A world without the file that names it, and a pointer to a world that is
  # not there, are not saves.
  mkdir -p -- "${fixture}/palworld-nameless/SaveGames/0/${palworld_guid}"
  printf 'level\n' >"${fixture}/palworld-nameless/SaveGames/0/${palworld_guid}/Level.sav"
  if game_save_sentinel "${fixture}/palworld-nameless" palworld; then exit 1; fi
  mkdir -p -- "${fixture}/palworld-other/SaveGames/0/FEDCBA9876543210FEDCBA9876543210" "${fixture}/palworld-other/Config/LinuxServer"
  printf 'level\n' >"${fixture}/palworld-other/SaveGames/0/FEDCBA9876543210FEDCBA9876543210/Level.sav"
  cp -- "${palworld_world}/Config/LinuxServer/GameUserSettings.ini" "${fixture}/palworld-other/Config/LinuxServer/"
  if game_save_sentinel "${fixture}/palworld-other" palworld; then exit 1; fi
  # An empty level file is not a save.
  mkdir -p -- "${fixture}/palworld-empty/SaveGames/0/${palworld_guid}" "${fixture}/palworld-empty/Config/LinuxServer"
  : >"${fixture}/palworld-empty/SaveGames/0/${palworld_guid}/Level.sav"
  cp -- "${palworld_world}/Config/LinuxServer/GameUserSettings.ini" "${fixture}/palworld-empty/Config/LinuxServer/"
  if game_save_sentinel "${fixture}/palworld-empty" palworld; then exit 1; fi
)

palworld_archive_output="$(
  SPAWNPOINT_GAME=palworld \
  SERVER_DATA_DIR="${palworld_world}" \
  SERVER_BACKUP_DIR="${fixture}/backups" \
  WORLD_NAME=palworld \
    "${SCRIPTS}/archive-world.sh"
)"
palworld_archive="$(awk -F= "${AWK_ARCHIVE_LINE}" <<<"${palworld_archive_output}")"
palworld_listing="$(tar --list --zstd --file "${palworld_archive}")"
grep -qx "SaveGames/0/${palworld_guid}/Level.sav" <<<"${palworld_listing}"
grep -qx "SaveGames/0/${palworld_guid}/Players/00000000000000000000000000000001.sav" <<<"${palworld_listing}"
grep -qx 'Config/LinuxServer/GameUserSettings.ini' <<<"${palworld_listing}"
if grep -q 'PalWorldSettings.ini\|^Logs' <<<"${palworld_listing}"; then exit 1; fi
SPAWNPOINT_GAME=palworld WORLD_NAME=palworld "${SCRIPTS}/verify-archive.sh" "${palworld_archive}" >/dev/null
expect_failure "a palworld archive judged by another game's sentinel" \
  env SPAWNPOINT_GAME=valheim WORLD_NAME=palworld "${SCRIPTS}/verify-archive.sh" "${palworld_archive}"
expect_failure "a valheim archive judged by palworld's sentinel" \
  env SPAWNPOINT_GAME=palworld WORLD_NAME=valheim "${SCRIPTS}/verify-archive.sh" "${valheim_archive}"
SPAWNPOINT_GAME=palworld WORLD_NAME=palworld \
  "${SCRIPTS}/restore-world.sh" "${palworld_archive}" "${fixture}/palworld-restored" >/dev/null
diff -r -- "${palworld_world}/SaveGames" "${fixture}/palworld-restored/SaveGames"
cmp -- "${palworld_world}/Config/LinuxServer/GameUserSettings.ini" "${fixture}/palworld-restored/Config/LinuxServer/GameUserSettings.ini"
expect_failure "archiving a palworld data dir whose world is not named" \
  env SPAWNPOINT_GAME=palworld SERVER_DATA_DIR="${fixture}/palworld-nameless" \
    SERVER_BACKUP_DIR="${fixture}/backups" WORLD_NAME=palworld \
    "${SCRIPTS}/archive-world.sh"

# Every module declares its facts once, in a manifest the Lambdas, Terraform
# and the release builder read too (ADR-0088). The shape is checked here, and
# a capability the manifest claims is a hook the module defines.
for module in "${GAMES}"/*/game.sh; do
  game="$(basename "$(dirname "${module}")")"
  manifest="${GAMES}/${game}/game.json"
  jq -e --arg id "${game}" '
    .id == $id and
    (.code | type == "string" and test("^[A-Z]{2}$")) and
    (.display_name | type == "string" and length > 0) and
    (.connect.port | type == "number" and . > 0 and . < 65536) and
    (.connect.protocol | IN("tcp", "udp")) and
    ((.connect.port_implied // false) | type == "boolean") and
    (.probe_port | type == "number" and . > 0 and . < 65536) and
    (.slottable | type == "boolean") and
    (.default_auth | IN("none", "game")) and
    (.footprint.memory_mib | type == "number" and . > 0) and
    (.footprint.cores | type == "number" and . > 0) and
    (.capabilities.whitelist | type == "boolean") and
    (.release == null or (.release | (.version_field | type == "string") and (.loader_versioned | type == "boolean")
      and (.runtime_image_required | type == "boolean")
      and (.loader_types | type == "array" and length > 0) and (.default_loader_type as $d | .loader_types | index($d) != null)
      and (.bare_loader_types | type == "array") and (.resolvers | type == "array")
      and (.side_lists | type == "boolean") and (.addons | type == "boolean") and (.requires_curseforge_key | type == "boolean")))
  ' "${manifest}" >/dev/null || { printf 'FAIL: %s has no valid game.json\n' "${game}" >&2; exit 1; }
  # A game that builds releases gives its players install notes for the pack.
  if [[ "$(jq '.release != null' "${manifest}")" == true ]]; then
    [[ -f "${GAMES}/${game}/pack-notes.txt" ]] || { printf 'FAIL: %s builds releases but has no pack-notes.txt\n' "${game}" >&2; exit 1; }
  fi
  (
    # shellcheck source=/dev/null
    source "${module}"
    claims="$(jq -r '.capabilities.whitelist' "${manifest}")"
    defines=false
    declare -F game_render_whitelist >/dev/null && declare -F game_reload_whitelist >/dev/null && defines=true
    [[ "${claims}" == "${defines}" ]] || { printf 'FAIL: %s claims whitelist=%s but defines its hooks: %s\n' "${game}" "${claims}" "${defines}" >&2; exit 1; }
  )
done

# Records that name no game belong to one module, named by its manifest
# (ADR-0089); no script spells that game out as a fallback.
[[ "$(jq -s '[.[] | select(.legacy_default == true)] | length' "${GAMES}"/*/game.json)" == "1" ]] ||
  { printf 'FAIL: exactly one game manifest must set legacy_default\n' >&2; exit 1; }
[[ "$(bash -c "source '${GAMES}/_legacy-game.sh'; printf '%s' \"\${LEGACY_GAME_ID}\"")" == "$(jq -r 'select(.legacy_default == true) | .id' "${GAMES}"/*/game.json)" ]]
if grep -nE '// "(minecraft|factorio|zomboid|valheim|palworld)"|:-(minecraft|factorio|zomboid|valheim|palworld)\}' \
  "${GAMES}/_dispatch.sh" "${SCRIPTS}"/*.sh "${REPOSITORY_ROOT}"/scripts/*.sh; then
  printf 'FAIL: a script names a game as the fallback for a record that names none; use LEGACY_GAME_ID\n' >&2
  exit 1
fi

printf 'game-adapter-test: ok\n'
