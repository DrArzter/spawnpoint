#!/usr/bin/env bash

# Per-game facts about an authoring profile (ADR-0034). A profile lives in the
# operator's own configuration repository — one per game, because each game's
# authoring contract differs: minecraft pins a loader and CurseForge URLs,
# factorio pins an engine version and portal versions. A profile names its game
# in a `game` field, and absence means the legacy game (ADR-0089), so every existing profile and
# every release cut from one keeps its exact pre-axis behaviour.
#
# The facts come from the game's manifest (server/games/<id>/game.json,
# ADR-0088), never from sourcing its module: these scripts also run inside the
# CodeBuild release bundle, which carries the manifests but not the modules.
#
# shellcheck shell=bash
# shellcheck disable=SC2034  # the PROFILE_* variables are this library's interface, read by its sourcers

# shellcheck source=../games/_legacy-game.sh
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/../games/_legacy-game.sh"

profile_game() {
  jq -r --arg legacy_game "${LEGACY_GAME_ID}" '.game // $legacy_game' "$1"
}

profile_game_facts() {
  local game="$1" manifest
  [[ "${game}" =~ ^[a-z0-9][a-z0-9-]{0,31}$ ]] || {
    printf 'error: invalid profile game: %s\n' "${game}" >&2
    exit 1
  }
  manifest="$(dirname -- "${BASH_SOURCE[0]}")/../games/${game}/game.json"
  jq -e '.release | type == "object"' "${manifest}" >/dev/null 2>&1 || {
    printf 'error: unsupported profile game: %s\n' "${game}" >&2
    exit 1
  }
  PROFILE_VERSION_FIELD="$(jq -r '.release.version_field' "${manifest}")"
  PROFILE_LOADER_TYPE="$(jq -r '.release.loader_type' "${manifest}")"
  PROFILE_LOADER_VERSIONED="$(jq -r '.release.loader_versioned' "${manifest}")"
  PROFILE_MOD_EXTENSION="$(jq -r '.release.mod_extension' "${manifest}")"
  PROFILE_RESOLVER="$(jq -r '.release.resolver' "${manifest}")"
  PROFILE_RUNTIME_IMAGE_REQUIRED="$(jq -r '.release.runtime_image_required' "${manifest}")"
}

# The shape every game's profile must have, in that game's own vocabulary.
validate_profile_metadata() {
  local profile="$1"
  jq -e \
    --arg version_field "${PROFILE_VERSION_FIELD}" \
    --arg loader_type "${PROFILE_LOADER_TYPE}" \
    --argjson loader_versioned "${PROFILE_LOADER_VERSIONED}" \
    --argjson runtime_image_required "${PROFILE_RUNTIME_IMAGE_REQUIRED}" '
    .schema_version == 1 and
    (.id | type == "string" and test("^[a-z0-9][a-z0-9-]{0,31}$")) and
    (.[$version_field] | type == "string" and length > 0) and
    (if $loader_type == "minecraft"
      then (.loader.type | IN("vanilla", "forge", "neoforge", "fabric", "quilt"))
      else .loader.type == $loader_type
    end) and
    (if $loader_type == "minecraft" and .loader.type == "vanilla"
      then (.loader.version == null or (.loader.version | type == "string" and length > 0))
      elif $loader_versioned
      then (.loader.version | type == "string" and length > 0)
      else .loader.version == null
    end) and
    (if $runtime_image_required
      then (.runtime.image | type == "string" and test("^[A-Za-z0-9._/-]+(:[A-Za-z0-9._-]+)?@sha256:[0-9a-f]{64}$"))
      else ((has("runtime") | not) or
        (.runtime.image | type == "string" and test("^[A-Za-z0-9._/-]+(:[A-Za-z0-9._-]+)?@sha256:[0-9a-f]{64}$")))
    end) and
    (.mods.source == null or (.mods.source | type == "string" and length > 0)) and
    ((.mods.resolver // null) == null or
      ((.mods.resolver | type == "string") and (.mods.resolver | IN("curseforge-files", "curseforge-modpack", "factorio-portal")))) and
    (if .mods.source == null then ((.mods.resolver // null) == null) else true end) and
    all(.mods.server_only, .mods.client_only; . == null or (type == "string" and length > 0)) and
    # Side lists (ADR-0069) sit beside one list of CurseForge files: a modpack
    # brings its own client pack, and Factorio clients take the server mods.
    (if (.mods.server_only // .mods.client_only // null) == null then true
      else ($loader_type == "minecraft" and .mods.source != null and (.mods.resolver // "curseforge-files") == "curseforge-files")
    end) and
    # Addons (ADR-0077) pin extra mods on top of a modpack, with a side each.
    (.mods.addons == null or (
      (.mods.addons | type == "string" and length > 0) and
      $loader_type == "minecraft" and .loader.type != "vanilla" and .mods.resolver == "curseforge-modpack"))
  ' "${profile}" >/dev/null || {
    printf 'error: unsupported or invalid profile metadata: %s\n' "${profile}" >&2
    exit 1
  }
}
