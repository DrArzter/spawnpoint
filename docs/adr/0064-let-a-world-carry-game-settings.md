# ADR-0064 — Let a world carry game settings, applied at its next start

- Status: Accepted
- Date: 2026-10-09
- Milestone: M6
- Amends: [ADR-0040](0040-reusable-presets-and-world-wipes.md)
- Relates: [ADR-0022](0022-minecraft-account-as-linked-identity.md), [ADR-0034](0034-per-game-adapter.md),
  [ADR-0054](0054-place-a-session-on-a-host-with-room.md)

## Context

The owner asked for what a hosted server panel gives: change the difficulty, the player limit or flight without
editing files on a host. Today every Minecraft setting is a literal in `server/compose.yaml`, the same for every
world. A release carries mods only; nothing carries a setting per world.

ADR-0040 refused dashboard-only mod overrides per world: they create a second, unreviewed source of configuration and
break reproducible releases. Server settings are a different case. They do not change which code runs, a release stays
reproducible without them, and the owner changes them more often than mods.

Some settings the platform depends on. A port, RCON, the whitelist, online mode, the level folder or memory changed
from the panel would break the probes, the backup contract, the slot layout or the footprint (ADR-0022, ADR-0054).

## Decision

**A game module lists the settings a world may set, in `server/games/<game>/settings.json`.** Each entry has an id, a
label, a kind (choice, integer, boolean or text), the values it may take, its default and the container variable it
becomes. The list is code reviewed. A setting the platform depends on is never in it. The access API and the host both
read this one file, so they cannot disagree about what is valid.

**The values live on the world record, `worlds/<id>/world.json`, under `game_settings`**, with when and by whom they
were last changed. They outlive wipes and restores, as the world's name does. The bucket is versioned, so every earlier
set of values stays readable. `PUT /games/{gameId}/worlds/{worldId}/game-settings` (permission `world.manage`) checks
each value against the list and writes the record with a version check.

**They reach the server at its next start.** The host projects the record into its catalog when a session starts, and
every lifecycle command exports the values the world sets as the variables the list names. A running game is never
touched, so a save while the world runs is allowed and says when it applies.

**A setting the world never set is not sent.** Its compose entry has no value, so the container does not see it and
the server keeps what it had. Once a world sets a setting, it stays set, so putting it back to the default still
reaches the server. Difficulty keeps the default it always had.

**The host checks again.** A value outside its definition refuses the command. A setting the host's checkout does not
define is skipped with a warning, because the configured host may run an older checkout than the panel.

## Consequences

- Minecraft offers difficulty, game mode, player limit, the server list message, player versus player, flight,
  hostile mobs, view distance and simulation distance. Factorio and Project Zomboid offer none yet: their images write
  their settings files in ways this repository has not verified.
- A legacy world without a record has no settings. The panel does not offer them there.
- A world that never sets anything starts exactly as before. A world that sets a value replaces any hand edit of that
  property in its `server.properties`.
- Factorio's `mod-settings.dat` sits in the mods directory, which each release reconcile replaces. Per-world mod
  settings need their own decision.
- A new setting is a change to the list, the compose file and a test, reviewed like any other code.

## Alternatives

| Option | Why not |
| --- | --- |
| Edit `server.properties` on the host from the panel | Fleet hosts are disposable, the file is not in backups, and the API would need a write path to hosts |
| Put settings in the preset and rebuild the release | Every change would be a commit and a build for one world's difficulty; settings do not change which code runs |
| Accept any `server.properties` key | Ports, RCON, online mode and the level folder would become one click from breaking the platform |
| Send every setting, with defaults, on every start | A setting nobody changed would overwrite the existing value on a world that has run for months |
