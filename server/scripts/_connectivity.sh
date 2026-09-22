#!/usr/bin/env bash

# The connectivity registry and the gate-versus-auth invariant (ADR-0033).
#
# A strategy's gate property says whether reaching the port is itself
# restricted. The invariant refuses only the SILENT combination: a world whose
# effective auth is "none" published through a non-gating strategy. A declared
# auth in the catalog — "external" for authentication the control plane cannot
# see, such as a login mod or online-mode=true — is taken at its word.
#
# Each strategy is a module with prepare/publish/retract functions. Loading it
# never changes the game's module or the host placement policy.

load_connectivity() {
  local strategy_id="$1" module
  [[ "${strategy_id}" =~ ^[a-z0-9-]+$ ]] || { printf 'error: invalid connectivity strategy\n' >&2; return 1; }
  module="${SERVER_DIR}/connectivity/${strategy_id}.sh"
  [[ -f "${module}" ]] || { printf 'error: connectivity strategy %s is not installed\n' "${strategy_id}" >&2; return 1; }
  # shellcheck source=/dev/null
  source "${module}"
}

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

# A game module's footprint default, read the same way as its auth default:
# in a subshell, so loading a module to ask one question leaves nothing behind.
game_footprint_default() {
  local games_dir="$1" game_id="$2" field="$3"
  local module="${games_dir}/${game_id}/game.sh"
  [[ -f "${module}" ]] || {
    printf 'error: unknown game: %s (no %s)\n' "${game_id}" "${module}" >&2
    exit 1
  }
  (
    # shellcheck source=/dev/null
    source "${module}"
    case "${field}" in
      memory_mib) printf '%s\n' "${GAME_FOOTPRINT_MEMORY_MIB:?${game_id} declares no GAME_FOOTPRINT_MEMORY_MIB}" ;;
      cores) printf '%s\n' "${GAME_FOOTPRINT_CORES:?${game_id} declares no GAME_FOOTPRINT_CORES}" ;;
      *) printf 'error: unknown footprint field: %s\n' "${field}" >&2; exit 1 ;;
    esac
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
