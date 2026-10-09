#!/usr/bin/env bash

# A world's whitelist (ADR-0066): the record keeps the names, the host writes
# them with the UUIDs an offline server derives, and a running game reloads
# them. The names reach the host from the record, never from the command.

set -Eeuo pipefail

repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
scripts="${repository_root}/server/scripts"
fixture="$(mktemp -d /tmp/spawnpoint-whitelist-test.XXXXXXXX)"
cleanup() {
  rm -rf -- "${fixture}"
}
trap cleanup EXIT

# --- the UUID an offline server gives a name, as Java derives it ---
uuid() {
  local name="$1"
  bash -c 'source "$1/server/games/minecraft/game.sh"; minecraft_offline_uuid "$2"' _ "${repository_root}" "${name}"
  return $?
}
[[ "$(uuid Notch)" == "b50ad385-829d-3141-a216-7e7d7539ba7f" ]]
[[ "$(uuid DrArzter)" == "edf613ca-bf4d-31f0-a794-f21ac9c39769" ]]
[[ "$(uuid drarzter)" != "$(uuid DrArzter)" ]] # the case a player types is the case the server hashes

# --- the file is exactly the list, in place of whatever was there ---
render() {
  local directory="$1" names="$2"
  bash -c 'source "$1/server/games/minecraft/game.sh"; game_render_whitelist "$2" "$3"' _ "${repository_root}" "${directory}" "${names}"
  return $?
}
mkdir -p -- "${fixture}/data"
printf '[{"uuid":"00000000-0000-3000-8000-000000000000","name":"AddedByHand"}]\n' >"${fixture}/data/whitelist.json"
render "${fixture}/data" '["DrArzter","Alex_2"]'
jq -e --arg drarzter "$(uuid DrArzter)" --arg alex "$(uuid Alex_2)" \
  '. == [{uuid: $drarzter, name: "DrArzter"}, {uuid: $alex, name: "Alex_2"}]' "${fixture}/data/whitelist.json" >/dev/null
render "${fixture}/data" '[]'
jq -e '. == []' "${fixture}/data/whitelist.json" >/dev/null
for bad in '["a"]' '["has space"]' '["$(reboot)"]' '["seventeen_letters"]'; do
  if render "${fixture}/data" "${bad}" 2>/dev/null; then
    printf 'expected refusal: %s\n' "${bad}" >&2
    exit 1
  fi
done
jq -e '. == []' "${fixture}/data/whitelist.json" >/dev/null # a refused list leaves the file alone

# --- the record's names reach the catalog; a world that keeps none has none ---
world_id="minecraft-rostik-1a2b3c4d"
mkdir -p -- "${fixture}/bin" "${fixture}/s3/releases/worlds/${world_id}"
ln -s -- "${repository_root}/server/tests/fake-aws" "${fixture}/bin/aws"
write_record() {
  local game="$1" whitelist="$2"
  jq -n --arg id "${world_id}" --arg game "${game}" --argjson whitelist "${whitelist}" '{
    schema_version: 1, world_id: $id, game: $game, display_name: "Rostik", status: "active",
    connectivity: "zerotier", storage_layout: "generation",
    preset: {id: "industrial", repository: "https://github.com/DrArzter/config",
      commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      profile_digest: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"},
    current_generation: {id: "gen-123456781234123412341234567890ab", release: "1.2", created_at: "2026-10-09T10:00:00.000Z"}
  } + (if $whitelist == null then {} else {whitelist: {
    names: $whitelist, updated_at: "2026-10-09T11:00:00.000Z",
    updated_by: {identity_id: "identity-owner", display_name: "DrArzter"}
  }} end)' >"${fixture}/s3/releases/worlds/${world_id}/world.json"
}

# --- a running world reloads the list it now keeps; the command named only the world ---
cat >"${fixture}/bin/docker" <<'EOF'
#!/usr/bin/env bash
[[ "$1" == "compose" ]] || exit 90
shift
for argument in "$@"; do
  case "${argument}" in
    config) exit 0 ;;
    exec)
      seen=0
      : >"${FAKE_ARGUMENTS_FILE}"
      for word in "$@"; do
        if [[ "${seen}" == "1" ]]; then printf '%s\n' "${word}" >>"${FAKE_ARGUMENTS_FILE}"; fi
        [[ "${word}" == "rcon-cli" ]] && seen=1
      done
      [[ "${FAKE_RCON_FAIL:-0}" != "1" ]] || { printf 'Error: rcon connection refused\n' >&2; exit 1; }
      printf 'Reloaded the whitelist\n'
      exit 0
      ;;
  esac
done
exit 91
EOF
chmod 0755 "${fixture}/bin/docker"

apply() {
  env PATH="${fixture}/bin:${PATH}" FAKE_S3_ROOT="${fixture}/s3" RELEASE_BUCKET=releases \
    SPAWNPOINT_WORLDS_DIRECTORY="${fixture}/worlds" SERVER_ENV_FILE="${fixture}/missing.env" \
    FAKE_ARGUMENTS_FILE="${fixture}/arguments" "$@" "${scripts}/apply-whitelist.sh"
}
expect_exit() {
  local expected="$1" actual
  shift
  set +e
  apply "$@" >"${fixture}/output" 2>&1
  actual=$?
  set -e
  [[ "${actual}" == "${expected}" ]] || {
    printf 'apply-whitelist exited %s, expected %s\n' "${actual}" "${expected}" >&2
    cat "${fixture}/output" >&2
    exit 1
  }
}
data="${fixture}/worlds/${world_id}/generations/gen-123456781234123412341234567890ab/data"

write_record minecraft '["DrArzter","Mira"]'
expect_exit 0 WORLD_ID="${world_id}"
grep -Fxq 'result=reloaded' "${fixture}/output"
diff -u <(printf 'whitelist\nreload\n') "${fixture}/arguments"
jq -e '[.[].name] == ["DrArzter", "Mira"]' "${data}/whitelist.json" >/dev/null
# The host's shared catalog, which its running sessions were started with, is untouched.
if [[ -e "${repository_root}/server/runtime/world-catalog.json" ]] &&
  jq -e --arg id "${world_id}" 'any(.worlds[]; .id == $id)' "${repository_root}/server/runtime/world-catalog.json" >/dev/null; then
  printf 'apply-whitelist.sh rewrote the shared catalog\n' >&2
  exit 1
fi

# The game did not answer: the file is written and read at its next start.
write_record minecraft '["DrArzter"]'
expect_exit 3 WORLD_ID="${world_id}" FAKE_RCON_FAIL=1
grep -Fxq 'result=written_not_reloaded' "${fixture}/output"
jq -e '[.[].name] == ["DrArzter"]' "${data}/whitelist.json" >/dev/null

# A world that keeps no whitelist on its record is not one to apply.
write_record minecraft null
expect_exit 5 WORLD_ID="${world_id}"

# A game that keeps no whitelist file refuses.
write_record factorio '["DrArzter"]'
expect_exit 4 WORLD_ID="${world_id}" SPAWNPOINT_GAME_IMAGE=registry.example.invalid/factorio:9.9.9@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa

# Only a world id is accepted.
expect_exit 2 WORLD_ID='../etc'

# A record with something other than names never reaches a catalog.
write_record minecraft '["has space"]'
expect_exit 1 WORLD_ID="${world_id}"

printf 'whitelist test passed\n'
