#!/usr/bin/env bash

# Preset-source port. An adapter authenticates and verifies one external source,
# then materializes the same inert profiles/ tree for the shared catalog and
# release builders. Source-specific credentials and payloads stop here.

materialize_config_source() {
  local workspace="$1"
  local source_kind="${CONFIG_SOURCE_KIND:-github-snapshot}"
  local adapter_directory
  adapter_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/config-sources"

  case "${source_kind}" in
    github-snapshot)
      # shellcheck source=scripts/config-sources/github-snapshot.sh
      source "${adapter_directory}/github-snapshot.sh"
      ;;
    *)
      printf 'error: unsupported CONFIG_SOURCE_KIND: %s\n' "${source_kind}" >&2
      return 1
      ;;
  esac

  materialize_preset_source "${workspace}"
  [[ -d "${CONFIG_CHECKOUT:-}" && ! -L "${CONFIG_CHECKOUT}" ]] || {
    printf 'error: preset source adapter did not produce a regular CONFIG_CHECKOUT\n' >&2
    return 1
  }
  [[ -n "${CONFIG_SOURCE_ORIGIN:-}" && -n "${CONFIG_SOURCE_REVISION:-}" ]] || {
    printf 'error: preset source adapter did not produce origin and revision metadata\n' >&2
    return 1
  }
  CONFIG_SOURCE_KIND="${source_kind}"
}
