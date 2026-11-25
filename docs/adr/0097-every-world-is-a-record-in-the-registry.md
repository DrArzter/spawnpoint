# ADR-0097 — Every world is a record in the registry

- Status: Accepted
- Date: 2026-11-25
- Milestone: M6
- Relates: [ADR-0048](0048-one-instance-per-active-world.md), [ADR-0054](0054-place-a-session-on-a-host-with-room.md),
  [ADR-0062](0062-give-each-fleet-world-a-session-record-of-its-own.md), [ADR-0064](0064-let-a-world-carry-game-settings.md),
  [ADR-0066](0066-keep-a-world-whitelist-on-its-record.md), [ADR-0085](0085-a-persistent-host-serves-public-worlds-too.md)

## Context

The panel listed worlds from two places. Two Minecraft worlds on the configured host, `world` and `vanilla`, were
written into the Lambda code as "legacy worlds". Every other world was a record in the registry
(`worlds/<id>/world.json` in the release bucket). A legacy world had no world lifecycle in the panel, so it showed no
hosting and connection settings, no game settings, no whitelist, no config files and no wipes. The API could not change
them either, because each of these writes changes the world's record.

`world` already had a record. It was written in 2026-08, when the world was moved into wipes, in the shape of that
day: it names no placement. The host already read that record before its own static list. Only the panel did not,
because the static entry hid it. `vanilla` has no record, no release pointer and no backup.

## Decision

- **The registry is the only list of worlds.** `catalogWithPresets` lists the records of each game and nothing else.
  `gameCatalog` describes games, from their modules (ADR-0088), and no worlds. The static list, the
  `worldLifecycle` and `hostBinding` flags and the `worldLifecycleAvailable` field of the API's world are removed.
  Every listed world has the same actions in the panel and the same routes in the API.
- **A record keeps the shape it was written in; the reader translates it.** `world-registry.ts` holds an ordered list
  of named translations (`WORLD_RECORD_TRANSLATIONS`). Each lifts one older shape by one step; the parser applies them
  before it checks the record, so the rest of the code reads one shape. A writer always writes the newest shape.
  Nothing rewrites a stored record to upgrade it. The first translation is `placement-from-connectivity`: a record
  that names no placement means the configured host for ZeroTier and the fleet for anything else, as before
  ADR-0085. A new field with a meaning for old records gets a translation there, never a default where it is read.
- **A session is sized by its game.** Placement takes the footprint from the start request, else from the game.
  The per-world footprint override existed only in the static list and goes with it.
- **The configured host is reached by placement, not by a list.** A world whose record says `configured` starts
  through the configured path (placement `single`), as every configured world created from a preset already did.
  The placement coordinator no longer refuses a world by name (`bound_to_configured_host`).
- **The bot reads its world's record** for the address it prints, through the same catalog the panel uses.

## Consequences

- `world` shows Hosting & connection, Game settings, the whitelist, config files and its wipes, and can move to the
  fleet like any other world: its saves are archives of its wipe in S3.
- `vanilla` is retired from the panel (the owners' choice, 2026-11-25). It was never moved into wipes and has no
  backup. Any save it has stays on the configured host's volume, untouched. A vanilla world is created from the
  `vanilla-forge` preset like any other world.
- The host keeps `server/worlds/catalog.json` as its fallback for a world without a record. It is not a second list
  for the panel: the panel no longer reads it, and the drift tests between the two are removed. The file also feeds the
  configured host's Terraform (`infra/terraform/network.tf`), so retiring it is a separate change.
- A world the catalog does not describe takes slot zero only on a shared host. This was already true of every world
  created from a preset; the two static worlds were the only ones that could take another slot.
- `npm run launch-requirements` reports per game.

## Alternatives considered

| Option | Why not |
| --- | --- |
| Keep the static list and show the settings for it | The writes change a record; a world without one cannot keep them, so each action would need a second path |
| Write a fresh record for each legacy world at deploy | Writes production data from a deploy, and `world` already has a record that would be overwritten |
| Upgrade stored records in place to the newest shape | A migration run against production for each new field, and a reader that must still handle a record the run missed |
| A default at each reader (`placement ?? …`) | The rule spreads to every place that reads the field; the next field adds more of them |
