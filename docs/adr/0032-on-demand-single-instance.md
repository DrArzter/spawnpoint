# ADR-0032 — Run the game server on one on-demand EC2 instance

- Status: Accepted
- Date: 2026-08-13
- Milestone: M0
- Supersedes: [ADR-0004](0004-ec2-spot-for-the-game-server.md), whose title and decision say Spot. Its reasoning about
  why a game server tolerates interruption is still worth reading; its purchase model is not the plan
- Leaves standing: [ADR-0027](0027-spot-request-shape.md), which remains **Proposed, deferred**. Nothing here rejects
  Spot — it postpones it

## Context

[ADR-0004](0004-ec2-spot-for-the-game-server.md) chose Spot. [ADR-0027](0027-spot-request-shape.md) replaced its
request mechanism with a per-session EC2 Fleet, and was then deferred on 2026-08-12 when real prices arrived: Spot saves
about **$8 a month**, and costs a fleet created and destroyed per session, ten instance types, stop-on-interruption,
interruption handling, an orphaned-fleet alarm, and the risk of no server at ten o'clock because a pool is exhausted.

So the repository said Spot and the project ran on-demand. ADR-0004 absorbed eight rounds of edits trying to close that
gap — a retracted mitigation, a struck-through open question, an instance type settled in a footnote, a warning banner.
That is the failure mode the ADR format exists to prevent. This record replaces it rather than adding a ninth edit.

## Decision

**One on-demand EC2 instance**, started and stopped per session by [ADR-0006](0006-on-demand-start-and-idle-shutdown.md).
`StartInstances` and `StopInstances` on one instance ID — no fleet, no launch template, no capacity strategy.

| | |
| --- | --- |
| Instance type | `r8i.large` — 2 vCPU, 16 GiB, x86_64 |
| Region | `eu-central-1` |
| Purchase model | On-demand |
| Network | Public subnet, no NAT Gateway |
| State | A persistent EBS data volume that outlives the instance |

Four things carry over from [ADR-0004](0004-ec2-spot-for-the-game-server.md) unchanged, restated here so this ADR can be
read alone:

- **Public subnet, no NAT Gateway.** A NAT Gateway is about $32 a month, which would exceed the compute line. The
  instance uses a public address for outbound SSM, registry and ZeroTier traffic, but its security group has no
  inbound rules: neither the game nor SSH is public. See [ADR-0007](0007-ssm-instead-of-ssh.md) and
  [ADR-0024](0024-connectivity-modes.md).
- **x86, not Graviton.** The saving is under a dollar a month against a slower core, and Sinytra Connector makes an
  architecture problem likely to surface as a subtle failure under load rather than a clean refusal to start.
- **Single-thread performance is the selection criterion**, not a refinement. The main tick cannot be spread across
  cores, so no number of slower cores buys tick headroom.
- **Memory binds, cores do not.** Hence a memory-optimised `.large` rather than a general-purpose `.xlarge`.

**Compute and state stay separate**, which was ADR-0004's interruption discipline. On-demand instances are not
interrupted, so the reason changes — but the requirement does not, because it is what makes nightly stop and start,
instance rebuild, and the preview environments of [ADR-0029](0029-preview-environments.md) work at all. Keep it.

### Where the numbers live, and why not here

The instance price, the memory measurement, the price comparison across families and the world size are in
[docs/measurements.md](../measurements.md) and [docs/costs.md](../costs.md). They are **not** restated here.

That is deliberate, and it is the lesson from ADR-0004. Measurements change; a decision record that embeds them has to
be edited every time they do, and after enough edits it can no longer be read as a decision. This ADR records *what was
decided and why*. The arithmetic lives where arithmetic is allowed to change.

## Consequences

**Good**

- The server starts when asked. No Spot pool to be exhausted at ten o'clock at night, which was the realistic bad
  evening in [ADR-0027](0027-spot-request-shape.md).
- No interruption handling, no rebalance signal, no fleet lifecycle, no orphaned-fleet alarm. Several components that
  do not exist cannot fail.
- A stopped instance resumes with a warm disk, which is the fastest cold start available — and cold start is paid every
  night.
- Moving to Spot later is a launch-configuration change, not a redesign, because state already lives off the instance.

**Bad, or risky**

- Roughly twice the compute line. About $8 a month, paid for simplicity.
- **A stop that silently fails now costs about $129 a month instead of about $40.** This is the single most expensive
  way for the design to fail, and it became three times more expensive when Spot was deferred.
- No architectural pressure to handle instance loss, so the recovery path gets less exercise than it would have.

**Mitigations**

- The running-hours alarm in [ADR-0015](0015-observability-and-alerting.md) and the hard session cap in
  [ADR-0006](0006-on-demand-start-and-idle-shutdown.md) are now the cheapest insurance in the design rather than a
  nicety. Treat an unexpectedly running instance as an incident.
- The AWS Budgets alarm is the backstop behind both. See [docs/aws-account-checklist.md](../aws-account-checklist.md).
- Keep the restore path exercised deliberately, since interruption will not exercise it for us. Every preview
  environment restores a world copy, which does exactly this.

## Alternatives considered

| Option | Why not chosen |
| --- | --- |
| A per-session Spot fleet, per [ADR-0027](0027-spot-request-shape.md) | The right answer eventually, and follows AWS guidance. About $8 a month of savings against a large amount of machinery, before the basics work. Deferred, not rejected |
| One persistent Spot instance | The cheap version of Spot, and what ADR-0004 originally proposed. One type in one zone is the worst configuration for capacity, so it trades the $8 for the risk of no server that evening |
| A rented VPS at a flat monthly rate | Cheaper at these hours, and honestly compared in [docs/costs.md](../costs.md). It removes the entire subject of the project |
| Always on | Removes cold start. About six times the cost, and it contradicts the invariant in [docs/architecture.md](../architecture.md) |

## Open questions

- **Milliseconds per tick on the real instance under real load.** The accepted risk carried over from ADR-0004: the
  tick is single-threaded and a cloud core is slower than the desktop the pack was measured on. Recorded in M0, not
  gated on — the escalation is to step up a size, then a faster family, then decide whether it is good enough anyway.
- **The Availability Zone.** The data volume is zonal, so this choice binds every later launch and has to be made
  before the first resource exists. See [docs/aws-account-checklist.md](../aws-account-checklist.md).
- When to revisit Spot. Probably when the promotion pipeline and the watchdog have both run unattended for a while, at
  which point $8 a month buys less risk than it does today.
