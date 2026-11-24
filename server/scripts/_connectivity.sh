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

# The game's own auth model, from its manifest (ADR-0088). A manifest that
# declares none is treated as authenticating nobody — fail closed.
game_default_auth() {
  local games_dir="$1" game_id="$2"
  local manifest="${games_dir}/${game_id}/game.json"
  [[ -f "${manifest}" ]] || {
    printf 'error: unknown game: %s (no %s)\n' "${game_id}" "${manifest}" >&2
    exit 1
  }
  jq -r '.default_auth // "none"' "${manifest}"
}

# A game's footprint default, from its manifest like its auth default.
game_footprint_default() {
  local games_dir="$1" game_id="$2" field="$3"
  local manifest="${games_dir}/${game_id}/game.json"
  [[ -f "${manifest}" ]] || {
    printf 'error: unknown game: %s (no %s)\n' "${game_id}" "${manifest}" >&2
    exit 1
  }
  case "${field}" in
    memory_mib | cores) jq -er --arg field "${field}" '.footprint[$field]' "${manifest}" || {
      printf 'error: %s declares no footprint %s\n' "${game_id}" "${field}" >&2
      exit 1
    } ;;
    *) printf 'error: unknown footprint field: %s\n' "${field}" >&2; exit 1 ;;
  esac
}

assert_connectivity_invariant() {
  local auth="$1" strategy_id="$2"
  if [[ "${auth}" == "none" ]] && ! connectivity_is_gate "${strategy_id}"; then
    printf 'error: no authentication and connectivity %s does not gate access\n' "${strategy_id}" >&2
    printf 'hint: declare "auth": "external" in the catalog when authentication is handled outside the game defaults\n' >&2
    return 1
  fi
}
