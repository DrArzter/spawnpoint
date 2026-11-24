# ADR-0088 — A game declares its facts once

- Status: Accepted
- Date: 2026-11-24
- Milestone: M6
- Amends: [ADR-0034](0034-per-game-adapter.md) (the per-game adapter)

## Context

A game module (`server/games/<id>/`) owns how the host runs its game. Its facts were declared in four places: the
module's `game.sh` constants, the Lambdas' game catalog ("mirrors GAME_SLOTTABLE"), the release builder's table in
`_profiles.sh`, and Terraform, which read `game.sh` with a regular expression. Two operator scripts read it with `awk`.
To add a game meant to edit each copy, and a missed copy failed only in production.

## Decision

Each game module has a manifest, `server/games/<id>/game.json`, with the facts the rest of the platform needs:

- identity: `id`, `code`, `display_name`;
- `connect` (`port`, `protocol`, `port_implied`), `probe_port`, `slottable`, `default_auth`;
- `footprint` (`memory_mib`, `cores`);
- `capabilities` (`whitelist` today);
- `release`, for a game whose presets build releases: the version field, loader, mod extension, resolver and runtime
  image rule.

Every reader takes the manifest:

- the host: `load_game` exports the facts under their old `GAME_*` names, so no host script changes;
- the release builder: `_profiles.sh`, and the CodeBuild bundle carries the manifests;
- the Lambdas: `control-plane/game-modules.ts` is the one list of modules, and the catalog, footprints and game
  settings come from it;
- Terraform and the operator scripts: `jsondecode` and `jq`.

`game.sh` keeps what only the host needs (Compose files and service) and the hooks. The reasons for each fact stay
as a comment block in `game.sh`, since JSON has no comments. Keys are snake_case, as a host file's are.

## Consequences

- A new game is one folder. The host test checks each manifest's shape and that a claimed capability is a hook the
  module defines; a Lambda test fails when a folder is missing from the module list.
- The deployment-specific parts stay where they were: the configured legacy worlds in the Lambdas' catalog, and the
  world catalog on the host.
- Not yet: readers that assume Minecraft when a record names no game, and host scripts that branch on a game id. Those
  move behind the module next.
