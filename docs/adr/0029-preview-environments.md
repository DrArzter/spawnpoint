# ADR-0029 — Every proposal is tested in a throwaway preview environment before it can be approved

- Status: Proposed
- Date: 2026-08-12
- Milestone: M3
- Answers: the open question deferred in both [ADR-0009](0009-s3-as-mod-source-of-truth.md) and
  [ADR-0028](0028-update-proposals.md) — whether a release should be tested before promotion

## Context

Both of those ADRs asked whether a candidate release should be started somewhere disposable before it touches the real
server, and both deferred it the same way: "correct, and probably beyond a hobby budget."

**That cost assumption was wrong.** A test needs one instance for as long as a modded server takes to boot and answer —
call it ten minutes for 111 mods, generously twenty. At the on-demand rate now in [docs/costs.md](../costs.md),
$0.16758 an hour, that is **about three to six cents per proposal**. Even at a much larger instance and an hour of it, it
is small change. The reason to defer was the build effort, not the bill, and saying "budget" obscured that.

An earlier version of this paragraph said "under a cent, at the Spot rate", which was true when
[ADR-0027](0027-spot-request-shape.md) still planned Spot. It is deferred, so the figure is a few times higher and the
argument is unchanged.

Meanwhile the gap it leaves is the sharpest one in the design. The health check in
[ADR-0009](0009-s3-as-mod-source-of-truth.md) runs *after* the live server has already been stopped and reconciled: it
catches a release that fails to start, at the cost of an interrupted evening and a rollback. It cannot catch anything
before the fact, and it cannot catch a release that starts successfully and is subtly wrong.

One subtle failure matters more than the rest: **removing a mod can destroy content in an existing world.** Blocks and
items from a mod that is no longer loaded are dropped when chunks are read. A health check says "started fine". The
damage is discovered days later, by a player standing where their base used to be.

## Decision

A proposal opens a **pull request**, and the pull request builds a **preview environment**.

| Step | What happens |
| --- | --- |
| Propose | The candidate release opens a PR against the mod list, with the resolved version diff as a comment |
| Build | A throwaway instance starts with the candidate release and **a copy of the newest world backup** |
| Verify | Wait for healthy — server list ping plus an RCON command — then scan the log for mod load errors, and record milliseconds per tick after a few minutes of idle |
| Report | The result goes into the PR comment, and **the environment is torn down immediately** |
| Inspect | On request only. `/preview` in the PR brings one back in a few minutes |
| Approve | Merging the PR is the approval. That writes the live pointer and runs the promotion pipeline |

**Always a copy of the world, never the volume.** Restore the newest archive into a fresh volume for the preview. The
live world is not attached to a preview instance under any circumstance, which makes "test the new mod set against the
actual save data" safe to do rather than reckless.

### The preview does not live as long as the pull request

A pull request can sit open for days — somebody adds a mod, gets distracted, and comes back on Thursday. Holding a
server up for that is precisely the always-on cost this whole project exists to avoid, and an earlier draft of this ADR
answered it only with a TTL, which is a blunt instrument for a problem with a sharp shape.

The shape: **the environment is needed for the verification, not for the pull request.** Those have very different
lifetimes.

| | Lifetime | Cost while it exists |
| --- | --- | --- |
| Verification | Ten to twenty minutes, automatic, on every proposal | Under a cent |
| Inspection by a human | Only when somebody asks, and only while they are looking | Under a cent |
| **The result** | Forever, in the PR comment | Nothing — it is text |

So a preview obeys **exactly the same rule as the real server**: start on request, stop when idle. That needs no new
mechanism — it is the idle watchdog from [ADR-0006](0006-on-demand-start-and-idle-shutdown.md) pointed at a different
instance. Nobody on for N minutes, it stops.

**Teardown deletes the volume too.** A stopped instance costs nothing, but its volumes are billed continuously, and a
week of accumulated preview volumes is exactly the kind of quiet cost this design keeps catching. Re-restoring a few
hundred megabytes on relaunch takes seconds, which is cheaper than holding the disk.

A hard TTL stays as a backstop, with an alarm, for the case where the watchdog itself fails — the same treatment as a
forgotten fleet in [ADR-0027](0027-spot-request-shape.md). It is the second line of defence now rather than the first.

**A stale pull request is not a correctness problem.** The verification was against pinned versions and the release
records exactly those, so merging a week-old proposal deploys what was actually tested. It just deploys versions that
are a week old — worth a nudge in the comment, not a block.

## What this removes

**The pull request is the plan, and GitHub's review interface is the approval surface.** That was going to be a
generated diff page plus an approve button — see [web/README.md](../../web/README.md), which called the diff page the
one job that justified a panel existing. GitHub renders the list diff, the comment carries the resolved versions, and
merging is the gate. So the panel shrinks again, and this time the part that shrinks is the part that was hardest to
justify building.

**It also makes the auto-apply policy in [ADR-0028](0028-update-proposals.md) defensible.** That policy was written with
an honest limit: boring changes can apply themselves, but the health check only catches a failed start, so the boring
category had to stay genuinely boring. With a preview that boots the real world against the candidate set, "boring" can
be widened, because the claim behind it is now tested rather than assumed.

## Consequences

**Good**

- The failure that actually destroys worlds — a removed mod eating blocks — is caught before it reaches the real world,
  by testing against a copy of that world.
- A bad release costs a preview instance rather than an interrupted evening and a rollback.
- Anybody can *join* the preview and look at their base before approving. That is a far stronger review than reading a
  version diff.
- It exercises the restore path on every proposal, which turns [ADR-0010](0010-world-persistence-and-backups.md)'s
  restore drill from an annual event into something continuously proven.
- The review interface is GitHub's, not one to be built.

**Bad, or risky**

- A whole extra lifecycle to build and keep working: create, restore, verify, report, tear down.
- Feedback takes minutes, not seconds. 111 mods do not boot quickly, and a PR that sits amber for ten minutes trains
  people to ignore it.
- A preview left running is the expensive failure mode in this whole design, which is why it is stopped by the same
  watchdog as the real server rather than trusted to a timeout.
- In overlay connectivity mode a preview consumes a device slot, and the free tier has ten. See
  [ADR-0024](0024-connectivity-modes.md).
- Restoring a world copy per proposal costs time and transfer, though both remain small at the current 597.7 MiB.
- It tests loading and idling. It does not test an hour of five people playing, so subtle gameplay breakage still gets
  through.

**Mitigations**

- Build it after the promotion pipeline works by hand. A preview that cannot be promoted from is a toy.
- Idle watchdog first, hard TTL and an alarm second, and teardown wired to PR close as well as merge. Three
  independent ways for a preview to die, because the failure they prevent is the costly one.
- Report progress into the PR comment as it goes — restoring, booting, healthy — so ten minutes reads as progress
  rather than as a hang.
- Cap concurrent previews at one. Two proposals at once is already excluded by the single-flight rule in
  [ADR-0028](0028-update-proposals.md).

## Alternatives considered

| Option | Why not chosen |
| --- | --- |
| No pre-promotion test, as [ADR-0009](0009-s3-as-mod-source-of-truth.md) had it | Nothing to build, and the rollback does work. Pays for every bad release with an interrupted session, and never catches a release that starts fine and is quietly wrong |
| Test with a freshly generated world | Faster to set up and no restore step. Misses the failure that matters most, because content loss only shows up against a world that already contains that content |
| Owner tests locally before proposing | Free, and already possible — the compose file runs the same set. Manual, so it will be skipped, and a laptop is not the target platform |
| Promote to a second "staging" server kept permanently | Closest to a conventional environment pipeline. An always-on second server contradicts the invariant in [docs/architecture.md](../architecture.md#what-runs-when-nobody-plays) and costs more than everything else here |
| Test only high-risk proposals, per the policy | A reasonable saving on effort. At under a cent a run, there is nothing to save |

## Open questions

- Whether the relaunch command is open to everybody or only the owner. It spends money, so it belongs behind the same
  allow-list as starting the real server.
- How to detect content loss automatically rather than by somebody looking. Comparing the registry before and after is
  the obvious idea and may be more work than it is worth.
- Whether a preview should also run the client pack build, so the pack is proven before players are told about it.
- Whether the same mechanism should test a world *restore* on a schedule, independently of proposals, since the parts
  are now all built.
