# ADR-0090 — Game rules live in the module

- Status: Accepted
- Date: 2026-11-24
- Milestone: M6
- Relates: [ADR-0034](0034-per-game-adapter.md), [ADR-0088](0088-a-game-declares-its-facts-once.md), [ADR-0089](0089-a-record-that-names-no-game-belongs-to-the-legacy-module.md)

## Context

After ADR-0088 and ADR-0089 the platform still branched on game ids where a game behaves differently: the session
start (`if minecraft`), the release scripts (which loaders and runtime a game's releases carry, the players' install
notes), the profile rules (resolvers, side lists, addons), the release builder's CurseForge key, the console's
lifecycle commands, the whitelist's name rule and list command, and the panel's console suggestions.

## Decision

A difference between games is a fact in the game's manifest or a hook in its module, never a branch on its id.

- Release facts in `game.json`: `loader_types`, `default_loader_type`, `bare_loader_types`, `resolvers`,
  `side_lists`, `addons`, `requires_curseforge_key`, beside the existing `runtime_image_required`.
- The players' install notes are `server/games/<id>/pack-notes.txt`, a template the release upload fills.
- Host hooks: `game_legacy_mods_directory` and `game_apply_release_overrides`, optional, called by the session start.
- Console and whitelist facts (`console`, `whitelist` in `game.json`) reach the Lambdas through the module registry
  and the panel through the control-plane snapshot.

Inherently game-specific tools stay inside the game's own vocabulary (the Minecraft mod-set checker reads mod
metadata that names `minecraft` as a dependency); stored field names such as `minecraft_version` are not renamed.

## Consequences

- A new game, or a change to how one behaves, is a change to its folder.
- The host test checks the shape of every manifest's release facts and that a game that builds releases has install
  notes; the release bundle carries the manifests, the notes and the manifest helper.
