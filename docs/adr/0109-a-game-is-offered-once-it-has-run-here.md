# ADR-0109 — A game is offered once it has run here

- Status: Accepted
- Date: 2026-11-27
- Milestone: M6
- Builds on: [ADR-0108](0108-a-game-declares-what-its-launch-needs.md) (a game declares what its launch needs),
  [ADR-0015](0015-observability-and-alerting.md) (the session history it keeps)

## Context

Project Zomboid was offered in the panel before it had ever run on AWS. Its first three starts failed, about ten
minutes each. ADR-0108 catches the facts a manifest can declare. It cannot catch a game that is wired correctly but
has not been tried here.

A full acceptance run of every game was considered and declined as too much. What is wanted is smaller: a game that
has not run in this deployment is the Owner's to try, and nobody else meets it.

## Decision

**A game is proven once a session of it became ready in this deployment.**

Nothing stored already says so for good. The session history (`sessions#<world>`) is pruned after eight days,
operation records expire after 30 days, and a lifecycle record keeps only the current state. So one small fact is
added:

| Item | Key | Attributes | Written by |
| --- | --- | --- | --- |
| A game's proof | `proven#<gameId>` in the lifecycle table | `game_id`, `world_id`, `first_ready_at` | the lifecycle coordinator |

- The start workflow already calls the coordinator when a session is ready (`openSessionHistory`). That call now
  carries the game (`$.request.gameId`). The coordinator writes the proof once, with a conditional put; a later ready
  session of the same game changes nothing. A failed proof is logged and never fails the start.
- `provenGameKey` in `lambdas/src/domain/proven-games.ts` is the one builder of the key.
- The API reads the proofs with `GetItem`, which it already holds on that table. A game that ran before this writer
  was deployed has no proof yet: until its next ready session writes one, a ready start in the runs Step Functions
  keeps (90 days) counts, read-only, with the grants the API already has. A proof that cannot be read counts as
  proven, so a failed read never hides a game that runs. The answer is cached for a minute.
- The snapshot gives each game `proven: boolean`.

**An unproven game is the Owner's.** Creating a world, starting a session and promoting a world of an unproven game
need `access.owner.grant`, the permission only the Owner role holds. Any other role is refused with
`403 game_not_proven`. No role or permission is added.

**The panel follows.** A person without that permission is not offered an unproven game: the game picker and the
rest of the console leave it out. For an Owner, the picker marks it with an `Indicator` whose tooltip says it has not
run here yet. The console's `Indicator` gains an `inControl` form for a mark inside a button: no tab stop of its own,
its name joins the button's.

## Consequences

- A new game reaches other roles only after an Owner has had one session of it reach ready here.
- A game that ran more than 90 days before this change and has not run since becomes the Owner's again until its
  next ready session. On the day of this change that is none: Minecraft and Factorio have ready starts in the kept
  runs; Valheim, Palworld and Project Zomboid have none and are the Owner's to try.
- The proof is never removed. A game that later breaks stays proven; this decision is about first use, not health.
