# ADR-0051 — Restart a session without releasing the host

- Status: Proposed
- Date: 2026-09-16
- Milestone: M4
- Amends: [ADR-0006](0006-on-demand-start-and-idle-shutdown.md), which keeps on-demand start and idle shutdown, and
  loses "every session stop powers the host down" as an unconditional step
- Relates: [ADR-0010](0010-world-persistence-and-backups.md) (the verified archive every stop still takes, and its
  ruling that EBS snapshots are a supplement and never the primary mechanism),
  [ADR-0026](0026-tiered-backups.md) (rejected on measurement, and the source of the quiesce rule this decision has to
  answer for),
  [ADR-0040](0040-reusable-presets-and-world-wipes.md) (the generation a restore opens),
  [ADR-0048](0048-one-instance-per-active-world.md) (which changes who owns a host, not this primitive)

## Context

Restoring a backup is presented as one action and performed as two. The panel writes a new generation into the world
record, and the data only reaches a disk at the **next start** — `prepare-world.sh` downloads the archive, checks it
against the generation descriptor and unpacks it, and until somebody presses Start nothing has happened that a player
can see. When the host is asleep that is the right behaviour and costs nothing. When the host is **up**, it is not what
anybody asked for: the world the operator is looking at does not change, and the session they were in is gone.

The same gap has a second face. There is no way to bounce a stuck session. A hung game, a misbehaving mod or a wedged
RCON leaves one option — stop, which powers the machine down, and start, which boots it again, at the measured cost of
a cold start for something that needed a container restart.

Both want a primitive the system does not have: **stop the session, keep the host, start it again.**

Half of it already exists and is unused. `check-host-activity.sh` reports `host=idle` only when no game service runs on
the host, and `stop-session.sh` reads it as a separate question with its own exit code — the comment there says so in
as many words. The state machine ignores it: `Stop Instance` calls `ec2:stopInstances` unconditionally
(`workflows/stop-server.asl.json`). The question is asked and the answer is thrown away.

One more fact shapes the decision. Every session stop takes a verified archive before it stops anything. A restart
therefore inherits a backup it did not ask for. That is a safety property worth keeping, and it is also the reason a
restart is not instant.

## Decision

The stop state machine takes a **`keepHost`** input. Default false, so an ordinary stop still powers the machine down
and ADR-0006's cost model is untouched. With it set, the session stops, the world is archived as always, and the
instance is left running.

Two actions are built on it:

- **Restart.** Stop the session with `keepHost`, then start it again on the same world and the same generation. It is
  offered only while a session is running, and it is refused for the same reasons a stop is refused, including players
  being online.
- **Restore, applied now.** When the world being restored is the one currently live, the world-lifecycle workflow stops
  with `keepHost`, applies the generation change, and starts the session again. The operator gets the restored world in
  front of them. When the host is asleep, restore stays exactly what it is today: the pointer moves, and the next start
  materialises it.

**A restore never stops a session that belongs to a different world.** Today `worldLifecycleNeedsStop` asks whether the
restored world is active and whether the host is running, which is true while another world holds the session, so
restoring an idle world evicts players from a live one. The rule becomes: stop only when the restored world **is** the
live one.

### When a safe exit cannot be proven

A stop, a restart and a restore all rest on the same promise: the world is saved and archived before anything is torn
down. When that promise cannot be kept — the save fails, the player count cannot be read, the archive cannot be
verified — the session ends through a ladder of bounded attempts, each one a **different mechanism from the one that
just failed**, with no person in the loop:

1. **Copy the data volume as found.** A block-level snapshot of `aws_ebs_volume.data` asks the game for nothing, so it
   works precisely when the game is the problem. It is the only rung that adds something rather than taking something
   away, which is why it goes first: everything after it is recoverable.

   **This is not a backup, and must never be listed as one.** [ADR-0026](0026-tiered-backups.md) is right that a
   snapshot of a world mid-write is worth no more than an archive of one, and here the world is mid-write by
   definition — the game stopped answering. What this rung produces is a crash-consistent copy, the state a pulled plug
   would leave. It is kept as evidence and as a last resort, labelled as taken during a failed stop, and it never
   appears beside verified archives as something to restore from by choice. [ADR-0010](0010-world-persistence-and-backups.md)
   allows exactly this much: snapshots as a supplement, never as the mechanism.
2. **`compose stop`, with a bounded wait.** SIGTERM reaches the process's own handler, not the RCON socket that just
   failed. This is not the same attempt repeated — it is a different channel, and for Project Zomboid it is the *only*
   save path the image has: `game_save()` defers to the graceful shutdown on purpose.
3. **SIGKILL**, if the wait expires.
4. **Stop the host.**
5. **Notify**, naming what each rung achieved.

There is no state in which the system waits for a person. Waiting is only worth something if something retries while it
waits; the ladder retries, an idle wait does not. The machine has also already been patient before reaching this point:
the stop command is polled every 15 seconds up to 60 times, so a failure is declared a quarter of an hour after the stop
was asked for.

**A slow save must not look like a dead one.** That patience is a single number applied to every game, and it is sized
for Minecraft. Project Zomboid stores each map cell as its own file — a modest save was reported at 150 MB across
90,000 of them — so archiving it is bound by how many files there are rather than how many bytes, and a healthy archive
of a long-lived world can take minutes. Two things follow, and both are part of this decision because they decide when
the ladder fires at all:

- **The budget is per game, not global.** `stopTiming` already arrives as an input to the stop machine rather than a
  constant, so a game whose archive is slower is given more patience without any structural change.
- **The operation reports that it is alive.** A deadline alone cannot tell working from hung, so the long-running
  command emits progress, and the machine treats an operation that is still reporting as one that is still working. It
  is the same idea as the per-game `game_ready()` readiness probe, applied to an operation rather than a boot: without
  it, the ladder eventually shoots a world that was doing exactly what it was told.

Termination is therefore not a button. It is what a failed safe stop becomes, which removes the dangerous control from
the panel rather than guarding it: nobody can reach for it in a hurry, because there is nothing to reach for.

**What a termination costs, exactly.** What is lost is what the game had not yet written to the volume — not the play
since the last archive, because the volume survives a session and the next start reuses the generation directory on it.
That holds while a world lives on a durable volume. Under [ADR-0048](0048-one-instance-per-active-world.md), where the
volume goes away with the host, the same termination would cost everything since the last verified archive, and the
notification has to say so. Whichever is true, the message names the loss in time, not in adjectives.

**A save that survives may still be wrong, and that is not fixable.** A checksum proves an archive is intact, never
that the world inside it is sane. Two structural properties carry the weight instead. Nothing is ever overwritten —
generations are append-only and a restore opens a new one, so a bad save lands beside the good ones rather than on top
of them. And what cannot be proven must be **labelled and visible**: an archive produced by a failed stop is recorded as
unverified, and the panel has to list it as such. Today unverified objects are counted and withheld from the list, which
is exactly wrong here, because after a failed stop that object may be the only recent copy anybody has.

**What is recorded.** The operation ends as terminated, with the rung that succeeded, the snapshot it took, the last
verified archive and its time, and the automatic termination named as the actor. Nobody decided it, so nobody is implied
to have decided it.

Restart and restore-applied-now inherit all of this unchanged: they are a stop, and a stop that cannot prove itself
safe ends the same way.

## Consequences

**Good**

- Restore means restore. The word matches the effect whenever the effect is possible.
- A stuck session has an answer that costs a container restart rather than a cold boot.
- Restoring an idle world stops evicting players from a different one.
- Nothing is lost by restarting: the stop that precedes it leaves a verified archive, as every stop does.

**Bad, or risky**

- A kept host keeps spending. The stop machine is no longer what guarantees the machine goes away.
- A restart is not quick. It carries a full archive and upload, so on a large world it is a stop plus a start minus the
  boot, not a bounce.
- Two more ways to interrupt players, both of which look identical to a stop from inside the game.
- A session can now end in data loss without anybody agreeing to it. The loss is bounded, captured and announced, but it
  is not consented to.
- Snapshots accumulate, and they are taken exactly when nobody is watching. [ADR-0026](0026-tiered-backups.md) recorded
  why this is worse than it looks: incremental snapshots share blocks, so deleting one does not free what it appears to,
  and reasoning about what they cost is genuinely unintuitive. Without a retention rule they are a bill nobody chose.
- A crash-consistent copy is harder to judge than an archive. "Listable and the right size" does not prove anything
  about it, so whoever reaches for one is reaching for something nobody can vouch for.
- The ladder makes a failed stop slower than a clean one, on a path that is already the unhappy one.
- A liveness signal is one more thing that can lie. An operation that reports progress while achieving nothing buys
  itself patience it has not earned.

**Mitigations**

- The idle watchdog of ADR-0006 becomes the only thing that stops a host, which is what it was for. **Before this
  ships, the watchdog must be shown to stop a host whose session was stopped with `keepHost`** — otherwise a kept host
  runs until somebody notices.
- `keepHost` defaults to false, so every path that does not ask for it behaves as it does today.
- Restart is gated on holding both `session.stop` and `session.start`. It is both, and it invents no new permission.
- Termination is reachable only by failing a safe stop, so it cannot be chosen as a shortcut. It has no button.
- The snapshot is taken before anything else is attempted, so no later rung can make the state worse than it was found.
- Every termination notifies this game's session subscribers and leaves a record naming the rung, the snapshot and the
  loss, so it is never discovered later by accident.
- Progress extends patience, it does not remove the ceiling. An operation that reports forever still ends.

## Alternatives considered

| Option | Why not chosen |
| --- | --- |
| Leave restore as it is, and explain it in the panel | Honest, and still wrong: the operator has to stop and start by hand to see a restore they already asked for |
| Restore into the live data directory while the game runs | `restore-world.sh` refuses this on purpose. Writing a save under a running server is how a world is corrupted, not restored |
| Restart by stopping and starting the host, as today | Pays a cold boot for a problem inside a container, and it is the workaround this ADR exists to remove |
| A restart that skips the archive to be quick | Trades the one property that makes restarting safe for seconds. If speed is ever needed, snapshot the volume instead of skipping the backup |
| A force flag next to Stop, chosen up front | Makes the dangerous path as easy as the safe one, and it would be used first by anybody in a hurry |
| Leave the session running and report the failure | Not a decision, a deferral. The one option with no ceiling on cost: the host bills until somebody arrives, and the world may be degrading while it does |
| Block, and wait for a person to choose | A private group has no on-call. At night the answer arrives in the morning, while the host bills and the session is neither running nor stopped |
| Block, wait 30 minutes, then terminate | The wait buys nothing, because nothing retries during it, and the machine has already polled for 15 minutes before declaring the failure |
| Retry the same save over RCON | Repeats the attempt that just failed, through the channel that just failed. SIGTERM is the version of this idea that can work |
| Kill immediately, with a notification | Cheap and honest, and it throws away both the chance that SIGTERM would have saved cleanly and the copy that a snapshot would have kept. The ladder costs seconds and pennies to avoid that |

## Open questions

- Whether a restore applied to a live session should announce itself to the players it is about to disconnect.
- How long the SIGTERM wait should be. Too short wastes the rung; too long is the idle waiting this decision rejects.
- What progress a long-running archive can honestly report. Bytes written is easy and misleading on a file-count-bound
  archive; files processed needs a total nobody has counted yet.
- How long these copies are kept. ADR-0026's warning about shared blocks means a retention rule has to be written
  before the first one is taken, not after they accumulate.
- Whether an ordinary stop should take one too. That would be tiered backups again, which was rejected on measurement
  at roughly 30 GB. That threshold is expressed in bytes and was derived from Minecraft; for Project Zomboid the
  binding quantity is the number of files, and it would be reached long before 30 GB. The trigger needs restating
  before that game is deployed, not after.
