# ADR-0073 — A stop succeeds only when the world's archive is verified on its host

- Status: Accepted
- Date: 2026-11-21
- Milestone: M4
- Successor of: [ADR-0051](0051-restart-a-session-without-releasing-the-host.md) for the stop-gate rule only. Restart,
  `keepHost` and the failure ladder of ADR-0051 stay where they are.
- Relates: [ADR-0010](0010-world-persistence-and-backups.md) (the verified archive),
  [ADR-0048](0048-one-instance-per-active-world.md) (S3 is the world's home between sessions),
  [ADR-0054](0054-place-a-session-on-a-host-with-room.md) (placement, reservation and drain),
  [ADR-0062](0062-give-each-fleet-world-a-session-record-of-its-own.md) (the `world#` record key)
- Amended by [ADR-0081](0081-a-stop-may-disconnect-players.md) on 2026-11-23: a stop may disconnect players online for a holder of `session.stop.force`.

## Context

ADR-0051 says that every session stop takes a verified archive before it stops anything. CONTEXT.md says the same of a
*Reservation*: it is released only after the session's stop has verified its archive. The code did not keep this
promise in two cases.

1. **A retry after a failed backup.** `stop-session.sh` stops the game, then archives and uploads. When the upload
   fails, the stop fails. The retry finds the container `exited`, prints `result=already_stopped` and exits 0. The V1
   stop routes on SSM `Success`, so it stops the instance, and the fleet stop releases the reservation. No archive of
   the last session exists. The same path applies to a game that exited alone.
2. **A fleet stop with one transient error.** The fleet stop's `Find Placement` step had a `Catch` that sent the stop to
   the configured host. That host has no copy of a fleet world. The script found no container and exited 0. The stop
   released the reservation, and the launched host, which held the only copy, drained and was terminated.

In both cases a stop reported success with no archive. On a launched host that is data loss.

## Decision

**A stop succeeds only when this world's archive is verified on the host it ran on.**

The host script (`server/scripts/stop-session.sh`):

- On `running`, the stop is as before: player check, save, stop, archive, upload, record, then
  `result=session_stopped_and_backed_up`.
- On `absent` or `exited`, a stopped game is not proof of a backup.
  - When the world has no data on this host, the script prints `result=world_not_on_host` and exits 6.
  - When the save has changed since the archive the host's record names, or no record names one, the script archives
    and uploads, as for `running`.
  - Otherwise it prints `result=already_stopped_and_backed_up` and exits 0.
  - A wipe that began empty and never saved has nothing to lose. It counts as backed up.
- After each verified upload, the host records which archive its copy is (`.spawnpoint-archive.json`). The legacy layout
  now keeps this record too, in its data directory.

The V1 stop (`workflows/stop-server.asl.json`) stops the instance only when the command output holds
`result=session_stopped_and_backed_up` or `result=already_stopped_and_backed_up`. SSM `Success` alone falls to
`Session Stop Failed`. Exit 6 ends in `World Not On Host`.

The fleet stop (`workflows/stop-server-v2.asl.json.tftpl`):

- `Find Placement` has the standard Lambda `Retry`. When it still fails, the stop fails and the session stays
  `stopping`. The stop never guesses a host.
- A session with no placement stops the requested instance only for a configured world. A fleet world's record key
  starts with `world#` (ADR-0062). Such a session ends in `Fleet Session Unplaced`.

## Consequences

**Good**

- The only data-loss path found in the stop is closed. The *Reservation* rule in CONTEXT.md is now true in code.
- A game that exited alone is archived at its next stop, not lost.
- A repeated stop of an unchanged world does not upload a second archive.

**Bad, or risky**

- More stops fail. A failed stop leaves the session `stopping` and the host running until somebody acts or the lease
  expires. That costs money, not data.
- A fleet session that failed before it was placed now fails its stop. It used to pass by asking the configured host.
- During the rollout, a host on an older checkout prints `result=already_stopped`. The V1 stop now fails on it. This is
  the safe direction.
- "Changed since the last upload" compares file times with the record's time. A clock change on the host can make an
  unchanged world look changed. The cost is one extra archive.
- A host that holds an old copy of a fleet world from earlier work can still answer `already_stopped_and_backed_up`
  for it. The fleet stop no longer sends a fleet world to the configured host, so this needs a wrong placement.

## Alternatives considered

| Option | Why not chosen |
| --- | --- |
| Keep `already_stopped` as success and fix only the fleet `Catch` | Leaves case 1: a retry after a failed upload still passes with no archive |
| Always archive on `absent` or `exited` | Safe, but each repeated stop uploads a new archive of an unchanged world |
| Ask S3 for the newest archive and compare it with the local world | Needs a download or a manifest to compare. The local record already names the archive the copy is |
| Send a fleet stop with no placement to every launched host | Guesses. A failed lookup is a reason to stop and retry, not to search |
