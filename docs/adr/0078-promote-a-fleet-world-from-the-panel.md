# ADR-0078 — Promote a fleet world from the panel and keep its save

- Status: Accepted — implemented for fleet worlds; the release diff and compatibility rules (P3, P7) are not built
- Date: 2026-11-22
- Milestone: M4
- Relates: [ADR-0030](0030-desired-and-active-release.md) (the promotion workflow, amended the same day),
  [ADR-0052](0052-keep-a-release-while-a-generation-names-it.md) (restore onto the release that ran),
  [ADR-0054](0054-place-a-session-on-a-host-with-room.md) (fleet placement),
  [ADR-0062](0062-give-each-fleet-world-a-session-record-of-its-own.md) (a fleet world's own session record)

## Context

A modpack preset gets a new release when its upstream version changes, or when extra mods are added to it. A world that
must keep its save takes that release by promotion: the promote-release workflow writes the desired release, stops the
world with a verified backup, starts it on the new release, checks health and commits the active release. On failure it
returns to the previous active release.

Promotion was a command-line tool for the configured host only (`scripts/promote-release.sh`). It refused a fleet world.
A fleet world could only start a new wipe, which loses the save. The Prominence II world is a fleet world, and its save
must be kept when the preset gets a new release. `release.promote` existed as a permission, held only by the Owner role,
and no route used it.

## Decision

**The Owner promotes a fleet world's open wipe to another ready release of the same preset, from the panel or the API.**

1. **Route.** `POST /games/{gameId}/worlds/{worldId}/promote` with body `{release}`. The route is declared in its own
   feature module (`promotion-routes.ts`) with `release.promote`; the shared dispatcher checks it. Only the Owner role
   holds it. Capability: `releasePromotion`.
2. **Rules, checked before anything starts.** The request is refused when: the release is malformed; the world is
   unknown, archived or not a fleet world; the deployment does not launch fleet hosts; the release is not a ready
   release of the world's own preset; the wipe's pointer cannot be read or names another wipe; the wipe never passed a
   start (no active release); the release is already active; the world's own session record reports players online;
   another operation holds the world. Configured worlds keep the command-line tool.
3. **Workflow.** The API starts the same promote-release machine. Its input names `placement: fleet`, the world's own
   lifecycle key (`world#<id>`) as `serverId`, and the world's warm choice. Both nested starts (the target and the
   rollback) place the session as a panel start does: on a launched host with room, or a new one. The host reconciles
   the release at start. The stop is the fenced Lifecycle V2 stop of the world's own session.
4. **Data safety.** The promotion keeps the pre-promotion backup (ADR-0030, amended). A refused stop (players online)
   restores the previous desired release and changes nothing. A failed start of the target returns the pointer to the
   previous active release and starts the world on it. The save is never deleted: the world keeps its wipe, and the
   backup is on the pointer and protected from retention.
5. **Panel.** "Update release" is in the world's menu and on its row, in both skins, for a fleet world. It is disabled
   while the world reports players online, when no other built release exists, and before a first start. The dialog
   offers the preset's other releases, newest first, and needs the world ID typed to confirm. The running promotion
   shows as "Promoting release" in Operations.

## Consequences

**Good**

- A fleet world keeps its save across a modpack update or an addon release, without AWS credentials.
- The rules that refuse are in one pure function (`lambdas/src/control-plane/promotion.ts`) with a test for each.
- The CLI path for the configured host does not change: a request that names no placement still means the
  configured host.

**Bad, or risky**

- The panel gives the Owner a destructive action. A removed mod deletes its blocks and items at the first load; the
  release diff (P3) and the compatibility rules (P7: refuse a Minecraft or loader change and a downgrade, typed
  confirmation for a removed mod) are not built yet.
- The players-online check reads the last watchdog observation, which can be up to one check interval old. The fenced
  stop is the authoritative check.
- The fleet target start can land on another host than the last session. The world comes from its newest verified
  archive in S3, as at every fleet start (ADR-0048, amended).

**Mitigations**

- Typed confirmation of the world ID, Owner-only permission, and the protected pre-promotion backup with restore onto
  the release it ran (ADR-0052, amended).
- The runbook says to compare the mod lists of the two releases and to read every changelog in between first.

## Alternatives considered

| Option | Why not chosen |
| --- | --- |
| A separate fleet promotion machine | Duplicates the commit, refusal and rollback paths that are already accepted and tested |
| Start a new wipe on the new release | Loses the save; that is the problem this solves |
| Give Operators `release.promote` | The owner kept promotion Owner-only |
| Promote configured worlds from the panel too | Out of scope for this change; the configured host's game record is shared by its worlds, and the CLI stays the path |
