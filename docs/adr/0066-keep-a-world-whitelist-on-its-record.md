# ADR-0066 — Keep a world's whitelist on its record

- Status: Accepted
- Date: 2026-10-09
- Milestone: M6
- Relates: [ADR-0022](0022-minecraft-account-as-linked-identity.md), [ADR-0048](0048-one-instance-per-active-world.md),
  [ADR-0063](0063-run-console-commands-through-one-ssm-document.md), [ADR-0064](0064-let-a-world-carry-game-settings.md)

## Context

A Minecraft world runs with `online-mode=false` and an enforced whitelist (ADR-0022). The whitelist lived in
`whitelist.json` in the world's data directory, filled by hand. That file is not in any backup, so a world that moves to a
new host, as every `cold` fleet session does (ADR-0048), arrives with an empty whitelist: with enforcement on, nobody can
join.

Filling it from the console does not work either. An offline server keys a player by the UUID it derives from the name,
Java's `UUID.nameUUIDFromBytes("OfflinePlayer:" + name)`. `whitelist add` first asks Mojang for the name, and for a real
account it stores the online UUID, which the offline server never sees: that player is turned away. The image's own
`WHITELIST` variable resolves names through PlayerDB or Mojang in the same way.

ADR-0022 proposes deriving the whitelist from linked Minecraft identities. That needs a way to link a name, and an
offline server cannot prove that a name belongs to anyone. Until then, the people who run a world need to say who may
join it, from the panel, and have it hold on every host.

## Decision

**The world record keeps the whitelist**, `worlds/<id>/world.json` under `whitelist`: the names, when and by whom they
were last changed. Absent means Spawnpoint does not keep this world's whitelist, and its server's own file is left as it
is. Present, even empty, means these names are the whole list. It outlives wipes and restores, as the world's name does.

**The host writes it, with offline UUIDs.** At every start, the game module writes `whitelist.json` from the record's
names, each with the UUID an offline server derives, in place of what was there. Compose sets no `WHITELIST`, so the
image leaves the file alone. A game without a whitelist file ignores the list, with a warning.

**A running world reloads it at once.** `PUT /games/{gameId}/worlds/{worldId}/whitelist` (permission `whitelist.manage`,
held by operators and owners) saves the list and, when the world's session is ready, sends the `spawnpoint-whitelist`
SSM document to the host and slot that session holds. The document carries only the world and the slot. The host reads
the names from the record itself, writes the file and runs `whitelist reload`. The API does not wait: a list that does
not reach the running game is written at the next start.

**A name is a Minecraft name, once.** Three to sixteen letters, digits or underscores, in the case the player types it,
because the case changes the UUID. Two names that differ only in case are refused as one typing mistake.

## Consequences

- Who may join a world is changed in its Whitelist tab, and holds on every host it lands on.
- The first name added to a world that kept no whitelist replaces the server's own list at its next start or reload.
  The panel says so before the first name is added.
- `whitelist add` at the console still stores the online UUID of a real account. The Whitelist tab is the way to add a
  player; the runbook says so.
- `ops.json`, `banned-players.json` and `server.properties` are still in no archive. Operators stay empty (ADR-0022);
  settings are ADR-0064's.
- ADR-0022 remains the destination: when a Minecraft name can be linked to an identity, the list can be derived from
  the links rather than typed.

## Alternatives

| Option | Why not |
| --- | --- |
| Put `whitelist.json` in each backup | Removing a player would need a new backup, and a restore would bring back players removed since |
| The image's `WHITELIST` variable | It looks names up online and stores the UUIDs an offline server never sees |
| `whitelist add` and `whitelist remove` over the console gateway | The same online lookup, and a stopped world would not take the change |
| Pass the names in the SSM command | Puts what a person typed into a host's shell parameters; reading the record keeps one source and no input on the command line |
