# ADR-0062 — Give each fleet world a session record of its own

- Status: Accepted
- Date: 2026-10-09
- Milestone: M6
- Amends: [ADR-0023](0023-multiple-worlds.md), which keeps "one of them active at a time" for the configured host only
- Relates: [ADR-0048](0048-one-instance-per-active-world.md), [ADR-0054](0054-place-a-session-on-a-host-with-room.md),
  [docs/lifecycle-v2-rollout.md](../lifecycle-v2-rollout.md)

## Context

Lifecycle V2 keeps one item per server in `spawnpoint-lifecycle-v2`, and the server has always been the game: the
item keyed `minecraft` holds the lease, the fencing token, the one active session and its watchdog for every
Minecraft world. Since 2026-09-22 a world created from a preset runs on an EC2 Fleet host launched for its session
(ADR-0054), so two Minecraft worlds no longer compete for a machine. They still compete for the record: the second
`beginSession` on `minecraft` is a conflict, and the panel refuses the second start with "Another world of this game
is already active". Worlds of different games already run side by side.

Two more things serialised the same evening. Every running start, stop, promotion or world operation refused every
other one, whatever world it was for, so a second world could not even start while the first was booting. And the
read model, the panel and the notifier knew one session per game: the panel named one active world, Telegram said
"Server is up" without saying which.

A fleet world is pinned to slot zero of its host (ADR-0054: a public world takes the game's own port), so two worlds
of one game never share a host. Nothing on the host side has to change: each session has its own Compose project,
data directory and DNS name already.

## Decision

**A fleet world's sessions live on a lifecycle record of its own, keyed `world#<worldId>`.** The coordinator was
always generic over its key; only the callers decided it was a game. Game and world ids never contain `#`, and the
table's other items are keyed `host#` and `dns-host#`, so `world#` collides with nothing. Every workflow carries the record's
key as `serverId`, as before; the start now also carries the world's `gameId` and display name, and placement asks by
game, because a footprint and the slot-zero rule belong to the game, not to the record.

**A configured world keeps its game's record.** The configured host runs one session at a time anyway, its legacy
worlds share one volume, and its owner scripts, the bot and promotion all address the game. Moving them would change
the record under a live host for nothing.

**Where a world's session lives is decided in one place**, `locateWorldSession` in `lambdas/src/control-plane`: a fleet
world's own record, unless its game's record still names it. A session begun under the game's record before this
change runs to its stop there; nothing is migrated. A configured world's session is its game's record only while that
record names it, so a stop in the name of the wrong world is refused instead of ending another world's session.

**A running operation blocks only its own world.** The operation list reads each running execution's input with
`DescribeExecution` and attributes it to the world the input names. A fleet world waits for its own operations; a
configured world waits for anything on the configured host; an operation that names no world, or whose input cannot
be read, blocks every world, as every operation did before. Execution names are not used: Step Functions caps them
at 80 characters, and the watchdog's nested stops already come close.

**Every surface reads the world's own session.** The snapshot gives each world a `session` view without the lease or
the fencing token; a fleet world's address is the one its own session reported. The panel's rows, verbs, refusals and
overview follow each world ("2 worlds online"), and the notifier names the world in its messages.

**The start machine fills what a caller leaves out**: the game from the server id, an empty world name, and the
configured host's placement, so the bot, the owner scripts and promotion's nested starts keep working unchanged.

## Consequences

- Two worlds of one game, or more, run at once on fleet hosts, and start and stop independently of each other.
- The configured host still runs one session at a time. A legacy world and a fleet world of the same game can run
  together, because they use different hosts and different records.
- Starts and stops are no longer serialised across worlds; each still holds its own record's fenced lease.
- Listing running operations costs one `DescribeExecution` per running execution, ten per machine at most. The access
  API and the projector gain that permission on their machines' executions.
- Owner scripts that read the lifecycle by game (`scripts/stop-server.sh`) see configured worlds only. Promotion
  refuses a fleet world: it stops and starts the configured host's session, and a fleet world takes its desired
  release at its next start.
- The stopped-host recovery in the projector still considers game records only, which is where configured sessions
  live; fleet hosts have the sweeper.
- Placing two sessions of one game on one host stays ruled out by the slot-zero pin. If that pin is ever relaxed, the
  host side has known gaps to close first: the Factorio RCON probe reads the slot-zero port, the world catalog file is
  rewritten per world, and the operator scripts match containers by service name only.

## Alternatives

| Option | Why not |
| --- | --- |
| Key every world's record by world, configured worlds too | Moves the record under a live configured host, and the bot, owner scripts and promotion address the game. Nothing gained: that host runs one session at a time |
| A sort key on the existing table, game plus world | The table has a single hash key and `prevent_destroy`; a new key schema means a new table and a migration, for the same effect as a key prefix |
| Keep the global operation gate | Two worlds would run together but start one after another, each start minutes long |
| Carry the world in execution names | Names cap at 80 characters; a 32-character world id pushes the watchdog's nested stop names past it |
