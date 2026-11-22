# ADR-0078 — Promote a fleet world from the panel and keep its save

- Status: Accepted — implemented for fleet worlds; amended 2026-11-22 for a wipe that never started; the release diff and compatibility rules (P3, P7) are not built
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
   release of the world's own preset; the wipe's pointer cannot be read or names another wipe; the release is already
   active; the world's own session record reports players online; another operation holds the world. Configured worlds
   keep the command-line tool. A wipe with no active release follows item 6.
3. **Workflow.** The API starts the same promote-release machine. Its input names `placement: fleet`, the world's own
   lifecycle key (`world#<id>`) as `serverId`, and the world's warm choice. Both nested starts (the target and the
   rollback) place the session as a panel start does: on a launched host with room, or a new one. The host reconciles
   the release at start. The stop is the fenced Lifecycle V2 stop of the world's own session.
4. **Data safety.** The promotion keeps the pre-promotion backup (ADR-0030, amended). A refused stop (players online)
   restores the previous desired release and changes nothing. A failed start of the target returns the pointer to the
   previous active release and starts the world on it. The save is never deleted: the world keeps its wipe, and the
   backup is on the pointer and protected from retention.
5. **Panel.** "Update release" is in the world's menu and on its row, in both skins, for a fleet world. It is disabled
   while the world reports players online and when no other built release exists. Before a first start it switches the release (item 6). The dialog
   offers the preset's other releases, newest first, and needs the world ID typed to confirm. The running promotion
   shows as "Promoting release" in Operations.
6. **A wipe that never started (amendment).** The same action and route also serve a wipe that has no save to keep.
   A wipe is not started when its pointer has no active release and no `releases_run` entry, no archive of the wipe
   exists, it came from the preset (not from a backup), and no session of the world is starting or running. For such a
   wipe the request switches the release and starts no workflow:
   - The release is any other release of the preset that a new world may use: a release in the preset's list, built
     from the current revision (`release_outdated` otherwise, as for a new world and a wipe, ADR-0042), and not
     retired or retiring. It may be newer or older. There is no save to protect.
   - **Write order.** Holders first (ADR-0080): the wipe's holder on the new release with roles `origin` and
     `desired`; a refusal stops the request before any pointer or record write. Then the wipe's pointer
     (`desired_release`, `updated_by`, `updated_at`) under its ETag. Then the world record's
     `current_generation.release` under its ETag. The pointer is first because a start reads it, and its ETag fails the
     write when a start committed meanwhile. A crash after the pointer leaves the record naming the old release as
     origin only, and a repeat of the request finishes it. A crash before leaves one extra holder. The old release's
     holder stays: only retirement removes a holder.
   - **No backup and no pre-promotion record.** The answer is `200 {result: "switched", release, previousRelease}`,
     not `202`. A lost race answers `409 world_changed`.
   - **Refusals** are `world_already_started` (a run, an archive, or a wipe restored from a backup),
     `session_active`, `operation_in_progress`, `release_already_selected`, `release_outdated`, and the existing
     release refusals. The archive listing is read only for a wipe with no active release.
   - The panel enables **Update release** for such a world. Its targets are the preset's releases a new world may
     use, other than the desired one. The pointer in the world snapshot gains `runCount`. The panel cannot see
     archives, so the API is the authority and its refusal is shown.
   - Permission, route and capability do not change: `release.promote`, the Owner role, `releasePromotion`. The old
     `no_active_release` refusal is gone: a wipe with no active release is switched or refused with one of the above.

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
