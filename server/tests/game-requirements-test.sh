#!/usr/bin/env bash

# What a game needs before a host is launched for it (ADR-0106), held for every
# game the same way:
#   * a Compose variable that must be set (`${VAR:?...}`) is either declared in the
#     manifest's required_secrets, which the API checks in SSM before a launch,
#     or set by the host scripts themselves;
#   * a declared secret is one the game reads, and its name is an .env key;
#   * start_timeout_seconds, when stated, fits inside the start document's hour;
#   * every image a session runs is pinned by digest.

set -Eeuo pipefail

server_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
failures=0
fail() {
  printf 'FAIL: %s\n' "$*" >&2
  failures=$((failures + 1))
}

# The files a session of the game runs, from its own module, relative to server/.
game_compose_files() {
  (
    # shellcheck source=../games/_dispatch.sh
    source "${server_directory}/games/_dispatch.sh"
    load_game "$1" >/dev/null
    local -a files=()
    IFS=':' read -r -a files <<<"${GAME_COMPOSE_FILES}"
    files+=("${GAME_FOOTPRINT_COMPOSE_FILE}")
    if [[ -n "${GAME_OBSERVABILITY_COMPOSE_FILES:-}" ]]; then
      local -a observability=()
      IFS=':' read -r -a observability <<<"${GAME_OBSERVABILITY_COMPOSE_FILES}"
      files+=("${observability[@]}")
    fi
    [[ -z "${GAME_HOST_OBSERVABILITY_COMPOSE_FILE:-}" ]] || files+=("${GAME_HOST_OBSERVABILITY_COMPOSE_FILE}")
    printf '%s\n' "${files[@]}"
  )
}

# A host script assigns the variable: `VAR=`, `export VAR=` or `local VAR=`.
set_by_host() {
  local name="$1" game="$2"
  grep -qE "(^|[[:space:];])(export[[:space:]]+)?${name}=" \
    "${server_directory}"/scripts/*.sh "${server_directory}"/games/_dispatch.sh "${server_directory}/games/${game}"/*.sh
}

games=()
for manifest in "${server_directory}"/games/*/game.json; do
  games+=("$(basename -- "$(dirname -- "${manifest}")")")
done
(( ${#games[@]} > 0 )) || { printf 'no game manifests found\n' >&2; exit 1; }

for game in "${games[@]}"; do
  manifest="${server_directory}/games/${game}/game.json"
  jq -e '.required_secrets | type == "array" and all(.[]; type == "string" and test("^[A-Z][A-Z0-9_]*$"))' \
    "${manifest}" >/dev/null || fail "${game}: required_secrets must be a list of .env keys"
  jq -e '.start_timeout_seconds == null or (.start_timeout_seconds | type == "number" and . == floor and . >= 60 and . <= 3000)' \
    "${manifest}" >/dev/null || fail "${game}: start_timeout_seconds must be a whole number from 60 to 3000"
  mapfile -t declared < <(jq -r '.required_secrets[]?' "${manifest}")
  mapfile -t files < <(game_compose_files "${game}")
  (( ${#files[@]} > 0 )) || { fail "${game}: no Compose files"; continue; }

  paths=()
  for file in "${files[@]}"; do
    [[ -f "${server_directory}/${file}" ]] || { fail "${game}: missing Compose file ${file}"; continue; }
    paths+=("${server_directory}/${file}")
  done

  # Required variables: declared, or set by the host.
  mapfile -t required < <(grep -hoE '\$\{[A-Za-z_][A-Za-z0-9_]*:?\?' "${paths[@]}" | sed -E 's/^\$\{([A-Za-z0-9_]+).*/\1/' | sort -u)
  for name in "${required[@]}"; do
    [[ " ${declared[*]} " == *" ${name} "* ]] && continue
    set_by_host "${name}" "${game}" && continue
    fail "${game}: Compose requires ${name}, which is neither in required_secrets nor set by a host script"
  done

  # A declared secret is one the game reads.
  for name in "${declared[@]}"; do
    grep -qE "\\\$\\{${name}([:?}-]|\$)" "${paths[@]}" "${server_directory}/games/${game}"/*.sh \
      || fail "${game}: required_secrets names ${name}, which the game never reads"
  done

  # Images: pinned by digest. Factorio's is the one exception in form only: it
  # is ${SPAWNPOINT_GAME_IMAGE}, which game.sh takes from a verified release
  # manifest and refuses unless it carries @sha256 (game_prepare_runtime).
  while IFS= read -r image; do
    image="${image#*image:}"
    image="${image//[[:space:]\"\']/}"
    [[ "${image}" =~ @sha256:[0-9a-f]{64}$ ]] && continue
    [[ "${game}" == factorio && "${image}" == '${SPAWNPOINT_GAME_IMAGE:?'* ]] && continue
    fail "${game}: image ${image} is not pinned by digest"
  done < <(grep -hE '^[[:space:]]*image:' "${paths[@]}")
done

# The same rule for the tier every session runs beside.
while IFS= read -r line; do
  image="${line#*image:}"
  image="${image//[[:space:]\"\']/}"
  [[ "${image}" =~ @sha256:[0-9a-f]{64}$ ]] || fail "observability: image ${image} is not pinned by digest"
done < <(grep -hE '^[[:space:]]*image:' "${server_directory}"/observability/compose*.yaml)

# The defaults the host reads: 600 unless the manifest says otherwise.
(
  # shellcheck source=../games/_dispatch.sh
  source "${server_directory}/games/_dispatch.sh"
  load_game valheim >/dev/null
  [[ "${GAME_START_TIMEOUT_SECONDS}" == 600 ]]
) || fail "a game without start_timeout_seconds must wait 600 seconds"
(
  # shellcheck source=../games/_dispatch.sh
  source "${server_directory}/games/_dispatch.sh"
  load_game zomboid >/dev/null
  [[ "${GAME_START_TIMEOUT_SECONDS}" == "$(jq -r .start_timeout_seconds "${server_directory}/games/zomboid/game.json")" ]]
) || fail "zomboid's start must wait what its manifest states"

(( failures == 0 )) || exit 1
printf 'result=passed\n'
