#!/usr/bin/env bash

# Per-game facts about an authoring profile (ADR-0034). A profile lives in the
# operator's own configuration repository — one per game, because each game's
# authoring contract differs: minecraft pins a loader and CurseForge URLs,
# factorio pins an engine version and portal versions. A profile names its game
# in a `game` field, and absence means minecraft, so every existing profile and
# every release cut from one keeps its exact pre-axis behaviour.
#
# Deliberately a table rather than a `source` of the game modules: these
# scripts also run inside the CodeBuild release bundle, which carries only the
# files Terraform packages, so the release path stays self-contained.
#
# shellcheck shell=bash
# shellcheck disable=SC2034  # the PROFILE_* variables are this library's interface, read by its sourcers

profile_game() {
  jq -r '.game // "minecraft"' "$1"
}

profile_game_facts() {
  local game="$1"
  case "${game}" in
    minecraft)
      PROFILE_VERSION_FIELD="minecraft_version"
      PROFILE_LOADER_TYPE="forge"
      PROFILE_LOADER_VERSIONED=true
      PROFILE_MOD_EXTENSION="jar"
      PROFILE_RESOLVER="curseforge"
      ;;
    factorio)
      PROFILE_VERSION_FIELD="factorio_version"
      PROFILE_LOADER_TYPE="factorio"
      # The engine is its own loader, so the profile carries no loader version
      # and the manifest reuses the engine version for it.
      PROFILE_LOADER_VERSIONED=false
      PROFILE_MOD_EXTENSION="zip"
      PROFILE_RESOLVER="factorio-portal"
      ;;
    *)
      printf 'error: unsupported profile game: %s\n' "${game}" >&2
      exit 1
      ;;
  esac
}

# The shape every game's profile must have, in that game's own vocabulary.
validate_profile_metadata() {
  local profile="$1"
  jq -e \
    --arg version_field "${PROFILE_VERSION_FIELD}" \
    --arg loader_type "${PROFILE_LOADER_TYPE}" \
    --argjson loader_versioned "${PROFILE_LOADER_VERSIONED}" '
    .schema_version == 1 and
    (.id | type == "string" and test("^[a-z0-9][a-z0-9-]{0,31}$")) and
    (.[$version_field] | type == "string" and length > 0) and
    .loader.type == $loader_type and
    (if $loader_versioned
      then (.loader.version | type == "string" and length > 0)
      else .loader.version == null
    end) and
    (.mods.source == null or (.mods.source | type == "string" and length > 0))
  ' "${profile}" >/dev/null || {
    printf 'error: unsupported or invalid profile metadata: %s\n' "${profile}" >&2
    exit 1
  }
}
