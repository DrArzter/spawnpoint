# ADR-0089 — A record that names no game belongs to the legacy module

- Status: Accepted
- Date: 2026-11-24
- Milestone: M6
- Amends: [ADR-0034](0034-per-game-adapter.md) ("absence means minecraft"), [ADR-0088](0088-a-game-declares-its-facts-once.md)

## Context

Worlds, profiles, release manifests and lifecycle inputs written before games were an axis carry no `game` field.
ADR-0034 kept them working by reading absence as Minecraft. That reading was written out in about twenty places: the
host's dispatcher and world catalog, the release scripts, the operator scripts, Terraform, the Lambdas' release plan
and object writer, and the notifier. Each repeated the game's name.

## Decision

The game module whose manifest sets `"legacy_default": true` owns every record that names no game. Exactly one
manifest sets it; a host test and a Lambda test fail otherwise.

- Shell: `server/games/_legacy-game.sh` exports `LEGACY_GAME_ID`, read from the manifests. Scripts pass it to `jq` as
  `$legacy_game` (`.game // $legacy_game`). The release builder's bundle carries the helper.
- Lambdas: `LEGACY_GAME_ID` in `control-plane/game-modules.ts`. The notifier passes the known games to the domain
  rule, which names none itself.
- Terraform: `local.legacy_game` in `infra/terraform/network.tf`.

Stored records are not rewritten: they keep reading as they did, through one declared fact.

## Consequences

- No platform file names the legacy game as a fallback. A host test greps the scripts for `// "<game>"` and
  `:-<game>}`; a Lambda test fails on any game id string in `lambdas/src`.
- Moving the legacy records to another game, or giving them an explicit `game`, is a change to one manifest or a data
  migration, not a code search.
