#!/usr/bin/env bash

# The connectivity registry and the gate-versus-auth invariant (ADR-0033).
#
# A strategy's gate property says whether reaching the port is itself
# restricted. The invariant refuses only the SILENT combination: a world whose
# effective auth is "none" published through a non-gating strategy. A declared
# auth in the catalog — "external" for authentication the control plane cannot
# see, such as a login mod or online-mode=true — is taken at its word.
#
# Strategy ids are registered here until the strategies become modules the way
# games did (ADR-0034); zerotier is the one implemented today, and
# start-session.sh refuses the others by name rather than by surprise.

connectivity_is_gate() {
  local strategy_id="$1"
  case "${strategy_id}" in
    zerotier) return 0 ;;
    raw | route53) return 1 ;;
    *)
      printf 'error: unknown connectivity strategy: %s\n' "${strategy_id}" >&2
      exit 2
      ;;
  esac
}

# The game's own auth model, read from its module in a subshell so nothing the
# module sets leaks into the caller. A module that declares none is treated as
# authenticating nobody — fail closed.
game_default_auth() {
  local games_dir="$1" game_id="$2"
  local module="${games_dir}/${game_id}/game.sh"
  [[ -f "${module}" ]] || {
    printf 'error: unknown game: %s (no %s)\n' "${game_id}" "${module}" >&2
    exit 1
  }
  (
    # shellcheck source=/dev/null
    source "${module}"
    printf '%s\n' "${GAME_DEFAULT_AUTH:-none}"
  )
}

assert_connectivity_invariant() {
  local auth="$1" strategy_id="$2"
  if [[ "${auth}" == "none" ]] && ! connectivity_is_gate "${strategy_id}"; then
    printf 'error: no authentication and connectivity %s does not gate access\n' "${strategy_id}" >&2
    printf 'hint: declare "auth": "external" in the catalog when authentication is handled outside the game defaults\n' >&2
    return 1
  fi
}
