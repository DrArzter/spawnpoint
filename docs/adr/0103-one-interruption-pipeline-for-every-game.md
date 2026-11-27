# ADR-0103 — One interruption pipeline for every game

- Status: Accepted
- Date: 2026-11-27
- Milestone: M6
- Amends: [ADR-0102](0102-spot-for-cold-launched-hosts-with-a-session-volume.md) — step 4, the host watcher
- Builds on: [ADR-0088](0088-a-game-declares-its-facts-once.md) (a game declares its facts once; the platform never names one)

## Context

ADR-0102 gave every Spot host a watcher. On the two-minute notice it announced a countdown, called the game's
`game_save`, flushed the session volume and reported the world as saved.

That is true only for a game whose `game_save` writes the world while the game runs: Minecraft (`save-all flush`),
Factorio (`/server-save`) and Palworld (its REST `save`). Project Zomboid and Valheim save only on a graceful stop.
Their `game_save` answers `save_deferred=graceful_shutdown` and writes nothing, and their image saves on SIGTERM.
The watcher counted that answer as a save. Two minutes later EC2 ends the host without a graceful stop, so the world
on the volume was the last autosave, perhaps half written, while the control plane had been told it was saved.

The first live fault test (2026-11-27, `docs/measurements.md`) also showed that every game's save takes its own
time, and that a budget is a guess until it is measured. More games will differ again: a game whose save comes from
a mod, a game whose state is a profile rather than a map ([ADR-0041](0041-evaluate-spt-profile-backed-adapter.md)).

## Decision

**Every session on a Spot host goes through the same five phases.** Only the save phase varies, and only in the way
the game module declares.

| Phase | What happens | Varies by game |
| --- | --- | --- |
| 1. Announce | the countdown, where the game can announce | no; skipped without `game_announce` |
| 2. Save | the world reaches the disk | yes: `interruption.save` |
| 3. Check | a save file written since the notice, and no write for two seconds | no |
| 4. Flush | `sync -f` on the session volume | no |
| 5. Report | `saved`, `failed` and `skipped`, in one `spawnpoint.host` event | no |

**A game module declares how it saves**, in `game.json`:

```json
"interruption": { "save": "live", "save_budget_seconds": 30 }
```

- `live`: `game_save` writes the world while the game runs. Its players stay until the host goes. A deferred answer is
  a failure, not a save.
- `stop`: only a graceful stop writes the world. The notice stops the game the way `stop.sh` does, so its players
  leave at the notice, about two minutes early.
- `save_budget_seconds`: the worst case of that save, measured by the fault test. Phase 3 waits for it.

A new way of saving (a mod's save command, a snapshot, a save that can be awaited) is a new value of `save` and one
branch in `save-session-for-interruption.sh`. No other game changes.

**The rules every game keeps:**

1. **A save is what phase 3 finds on the disk.** The report names a world `saved` only after phase 3. Nothing else is
   reported as saved.
2. **Spot needs a contract that fits the notice.** The module parser refuses `capabilities.spot: true` without an
   `interruption` block, or with a budget over 90 seconds: the 120-second notice less the announcements, the flush,
   the report and a margin for a late poll.
3. **Spot needs a measurement.** A game is on Spot only when `docs/measurements.md` has its section
   `## Spot interruption and move — <game>, measured …`. A test enforces it.
4. **A rebalance recommendation costs no player their game.** It saves a `live` game. It skips a `stop` game, because a
   recommendation is not yet a reclaim.

**Where things are:** phases 2 and 3 are `server/scripts/save-session-for-interruption.sh`, one session at a time, with
`result`, `method`, `reason` and `seconds` on every branch. Phases 1, 4 and 5 are `save-for-interruption.sh`, which the
watcher runs. The rules are in `lambdas/src/control-plane/game-modules.ts`.

## Consequences

- Minecraft stays on Spot: `live`, 30 s, measured at 24 s on 2026-11-27.
- Factorio and Palworld (`live`) and Valheim and Project Zomboid (`stop`) declare their way and leave Spot until each
  has a fault test and its measurement. Their budgets are first guesses. A start of such a world asks for an
  on-demand host again.
- A `stop` game's players are disconnected at the notice and told nothing after the save, because nobody is left.
- The report event gains `skipped`. The interruption Lambda reads `saved` and `failed` as before.
- An SPT adapter (ADR-0041) fits without a change: a mid-raid save mod is a `live` save in its `game_save`; without one
  the adapter declares `stop`, and a raid in progress is the documented loss.

## Alternatives considered

| Option | Why not chosen |
| --- | --- |
| Each game implements the whole interruption in its module | Five copies of announce, flush and report, each with its own idea of "saved" |
| An RCON `save` for Zomboid and Valheim | Neither says when the save is done; the watcher would be guessing again |
| Keep every game on Spot and lower the budget check to a warning | A warning does not stop a world from being lost |
