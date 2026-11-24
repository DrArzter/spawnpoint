# ADR-0093 — A world keeps its own config files

- Status: Accepted
- Date: 2026-11-24
- Milestone: M6
- Relates: [ADR-0064](0064-let-a-world-carry-game-settings.md), [ADR-0065](0065-hand-out-world-files-as-short-lived-links.md),
  [ADR-0066](0066-keep-a-world-whitelist-on-its-record.md), [ADR-0077](0077-pin-extra-mods-on-top-of-an-upstream-modpack.md)

## Context

A modpack's server configuration comes with its release: the managed roots (`config/`, `kubejs/` and the others) are
replaced at every start, so a file edited on a host is gone at the next one, and a fleet host is destroyed after its
session anyway. The panel can set nine `server.properties` values (ADR-0064) and download archives and mods
(ADR-0065), but it cannot change a mod's configuration. The owners asked for that.

## Decision

- A world may keep its own version of any text file inside its game's config roots. The game's manifest states the
  roots, the size limit (256 KiB for Minecraft) and the text extensions (`config_files` in `game.json`).
- Each version is stored once, under its SHA-256, at `worlds/<world>/config/<sha256>` in the release bucket. The world
  record keeps `config_files`: path to digest, size, the release digest the edit started from, when and by whom.
  The edits belong to the world: they outlive its wipes, like its whitelist and game settings.
- The API (`config.edit`, held by the Owner role and grantable) lists the release's files with the world's edits,
  reads one, saves one and resets one. A save names the digest it started from, and a save from a version that is no
  longer current is refused (`config_file_changed`). Saving the release's own bytes removes the edit. A path under the
  release's `world_data` (ADR-0077) is the world's running data and cannot be edited.
- At every start, after the release's configuration is reconciled, `apply-world-config.sh` writes each of the world's
  files into its data folder, checked against its digest and kept inside the config roots.

## Consequences

- A change takes effect at the world's next start, with no build. The panel shows when the release has changed a file
  since the world's edit, so an owner can compare or reset.
- A world's configuration can drift from its preset. A change every world should get still belongs in the preset.
- The API role may write only `worlds/*/config/*` besides what it wrote before; hosts already read `worlds/*`.
