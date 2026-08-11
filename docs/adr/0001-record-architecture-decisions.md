# ADR-0001 — Record architecture decisions

- Status: Accepted
- Date: 2026-08-11
- Milestone: —

## Context

This project is built in short evening sessions over months. Choices such as Spot instead of
on-demand, or a watchdog container instead of a cron job, look arbitrary six weeks later. The
reason is usually a constraint that is no longer visible in the code.

The project also serves as a portfolio piece. The question asked in interviews is not "what did
you build" but "why did you build it that way". A written decision, with the alternatives that
were rejected, answers that far better than the finished code.

## Decision

Record every non-obvious architecture decision as a numbered Markdown file in `docs/adr/`,
using the format in [0000-template.md](0000-template.md). ADRs are immutable once accepted; a
change of mind produces a new ADR that supersedes the old one.

A decision is worth an ADR when it is expensive to reverse, when a reasonable engineer would
choose differently, or when it was reached after real comparison.

## Consequences

**Good**

- The reasoning survives the gap between sessions.
- Rejected options are visible, so the same ground is not re-covered.
- Superseded ADRs show how the design evolved. That history is itself evidence of judgement.

**Bad, or risky**

- A small writing tax on every decision.
- ADRs rot if they are written after the fact, or if the code drifts and nobody updates status.

**Mitigations**

- Keep each ADR to one page. A thin ADR beats no ADR.
- Write the ADR before or during the change, not after. If it is written after, say so.
- Review the index at the end of each milestone and correct any stale status.

## Alternatives considered

| Option | Why not chosen |
| --- | --- |
| Comments in code | Cannot hold rejected alternatives or cost reasoning; disappears on refactor |
| One long design document | Grows into a wall of text; no way to see when or why something changed |
| Commit messages only | Not discoverable months later; buried under mechanical commits |
| No records | The original problem this project is trying to avoid |
