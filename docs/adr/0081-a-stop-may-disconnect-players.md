# ADR-0081 — A stop may disconnect players, for a holder of session.stop.force

- Status: Accepted
- Date: 2026-11-23
- Milestone: M6
- Amends: [ADR-0073](0073-a-stop-succeeds-only-when-the-worlds-archive-is-verified-on-its-host.md) (the host's stop
  command refuses while players are online)

## Context

The host's stop command refuses while players are online. This protects players from the idle watchdog. It also
blocks the owner: when players stay on, nothing in the panel can stop the world, and the session runs on while it is
billed.

## Decision

- A stop request may name `players: "disconnect"`. A request that names nothing refuses, as before. The idle watchdog
  never asks to disconnect.
- Disconnecting needs the new permission `session.stop.force`, in addition to `session.stop`. The route keeps
  `session.stop`. The handler checks the escalation, because it depends on the payload. Only the Owner holds it by
  default. A role or a direct grant can add it.
- The policy travels from the stop V2 machine to its V1 child and then to the host as `SPAWNPOINT_STOP_PLAYERS`. The
  V1 machine passes only `refuse` or `disconnect` to the host's shell. Any other value fails before EC2 is touched.
- With `disconnect`, the host reads the player list for the log and then stops. A failed read does not block the stop.
  The save, the archive and its verification are unchanged.
- The panel asks to disconnect only when the world shows players online and the caller holds the permission. The stop
  confirmation then names the number of players and reads "Disconnect and stop".

## Consequences

- The owner can always stop a world.
- A host that runs an app checkout from before this change ignores the variable and still refuses. A host takes the new
  scripts at its next session start.
- The panel's player count comes from the watchdog's last reading. If the count is stale and shows nobody, the panel
  sends a plain stop, which the host may refuse. The owner then stops again.
