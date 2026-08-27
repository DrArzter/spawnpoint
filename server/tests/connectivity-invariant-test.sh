#!/usr/bin/env bash

# The gate-versus-auth invariant (ADR-0033): only the silent combination — a
# world with no authentication published through a non-gating strategy — is
# refused. A declared auth is taken at its word. Both branches are exercised
# on every surface that enforces them: the pure functions, the static catalog
# validator, and the seam where a session starts.

set -Eeuo pipefail

REPOSITORY_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPTS="${REPOSITORY_ROOT}/server/scripts"
fixture="$(mktemp -d /tmp/spawnpoint-connectivity-test.XXXXXXXX)"
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

# --- the registry and the invariant as pure functions ---
# `! cmd` does not trip set -e, so the negative checks are explicit ifs.
(
  source "${SCRIPTS}/_connectivity.sh"
  connectivity_is_gate zerotier
  if connectivity_is_gate raw; then exit 1; fi
  if connectivity_is_gate route53; then exit 1; fi
  assert_connectivity_invariant none zerotier
  assert_connectivity_invariant game raw
  assert_connectivity_invariant external route53
  if assert_connectivity_invariant none raw 2>/dev/null; then exit 1; fi
  if assert_connectivity_invariant none route53 2>/dev/null; then exit 1; fi
)
expect_failure "an unknown strategy id" \
  bash -c "source '${SCRIPTS}/_connectivity.sh'; connectivity_is_gate hamachi"

# game defaults come from the modules; a module without one authenticates nobody
(
  source "${SCRIPTS}/_connectivity.sh"
  # Both default to none, and for the same reason: neither server verifies who
  # connects. Minecraft runs offline-mode; the factorio server is hidden, which
  # is what frees it from needing an account and from being able to verify one.
  [[ "$(game_default_auth "${REPOSITORY_ROOT}/server/games" minecraft)" == "none" ]]
  [[ "$(game_default_auth "${REPOSITORY_ROOT}/server/games" factorio)" == "none" ]]
)
expect_failure "a game with no module" \
  bash -c "source '${SCRIPTS}/_connectivity.sh'; game_default_auth '${REPOSITORY_ROOT}/server/games' heroes"

# --- the static surface: an unsafe catalog cannot even be loaded ---
write_catalog() {
  jq -n --argjson world "$1" '{
    schema_version: 1,
    profile_source: {
      repository: "https://example.invalid/profiles",
      commit: "0000000000000000000000000000000000000000"
    },
    worlds: [$world]
  }' >"${fixture}/catalog.json"
}
run_profile() {
  SPAWNPOINT_WORLD_CATALOG="${fixture}/catalog.json" "${SCRIPTS}/world-profile.sh" "$1"
}

# silent: offline-mode minecraft on a public strategy refuses, and the error
# names the fix rather than just the rule
write_catalog '{"id": "open", "display_name": "Open", "profile_id": "open", "connectivity": "raw"}'
if silent_output="$(run_profile open 2>&1)"; then
  printf 'expected failure: the silent combination\n' >&2
  exit 1
fi
grep -q 'does not gate access' <<<"${silent_output}"
grep -q '"auth": "external"' <<<"${silent_output}"

# declared: the operator's word wins
write_catalog '{"id": "open", "display_name": "Open", "profile_id": "open", "connectivity": "raw", "auth": "external"}'
declared_output="$(run_profile open)"
grep -Fxq 'connectivity=raw' <<<"${declared_output}"
grep -Fxq 'auth=external' <<<"${declared_output}"

# a hidden factorio server verifies nobody either, so the silent combination
# refuses for it too — the game's name is not the auth model
write_catalog '{"id": "pub", "display_name": "Pub", "profile_id": "pub", "game": "factorio", "connectivity": "raw"}'
expect_failure "a factorio world on a non-gating strategy with no declaration" run_profile pub

# the operator who runs the visible, credentialed variant says so, and publishes
write_catalog '{"id": "pub", "display_name": "Pub", "profile_id": "pub", "game": "factorio", "connectivity": "raw", "auth": "game"}'
factorio_output="$(run_profile pub)"
grep -Fxq 'auth=game' <<<"${factorio_output}"
grep -Fxq 'connectivity=raw' <<<"${factorio_output}"

# an explicit "none" is a written contradiction and refuses like the silent one
write_catalog '{"id": "w", "display_name": "W", "profile_id": "w", "game": "factorio", "connectivity": "raw", "auth": "none"}'
expect_failure "a declared none on a non-gating strategy" run_profile w

# the vocabulary is validated
write_catalog '{"id": "w", "display_name": "W", "profile_id": "w", "connectivity": "hamachi"}'
expect_failure "an unknown connectivity in the catalog" run_profile w
write_catalog '{"id": "w", "display_name": "W", "profile_id": "w", "auth": "yes"}'
expect_failure "an unknown auth value in the catalog" run_profile w
write_catalog '{"id": "w", "display_name": "W", "profile_id": "w", "game": "heroes"}'
expect_failure "a catalog naming a game with no module" run_profile w

# the real catalog stays valid and reports the axis with its defaults
main_output="$("${SCRIPTS}/world-profile.sh" main)"
grep -Fxq 'connectivity=zerotier' <<<"${main_output}"
grep -Fxq 'auth=none' <<<"${main_output}"
factorio_world_output="$("${SCRIPTS}/world-profile.sh" factorio)"
grep -Fxq 'connectivity=zerotier' <<<"${factorio_world_output}"
grep -Fxq 'auth=none' <<<"${factorio_world_output}"

# --- the runtime seam: start-session refuses an unimplemented strategy for
#     what the world is, before touching the environment or the host ---
write_catalog '{"id": "open", "display_name": "Open", "profile_id": "open", "connectivity": "raw", "auth": "external"}'
if session_output="$(WORLD_ID=open SPAWNPOINT_WORLD_CATALOG="${fixture}/catalog.json" \
  "${SCRIPTS}/start-session.sh" 2>&1)"; then
  printf 'expected failure: start-session on an unimplemented strategy\n' >&2
  exit 1
fi
grep -q 'not implemented yet' <<<"${session_output}"

printf 'connectivity-invariant-test: ok\n'
