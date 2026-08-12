# ADR-0027 — A diversified Spot fleet created per session, and stop-on-interruption within it

- Status: Proposed
- Date: 2026-08-11
- Milestone: M2
- Amends: [ADR-0004](0004-ec2-spot-for-the-game-server.md) — keeps its decision to use Spot, replaces its request mechanism,
  and **retracts its on-demand fallback**, which AWS explicitly discourages

## Context

[ADR-0004](0004-ec2-spot-for-the-game-server.md) chose Spot and left the mechanism open: "a Spot request with a
capacity-optimised strategy, or simply start and stop one persistent Spot instance. The second is simpler and is the
starting point." Reading AWS's own guidance answers that question and contradicts two things in that ADR.

**What the guidance says.** Verified 2026-08-11, sources below.

1. Spot is recommended for stateless, fault-tolerant, flexible workloads, and **explicitly not recommended** for
   workloads that are "inflexible, stateful, fault-intolerant". A game server is stateful and mildly
   fault-intolerant. That does not make Spot wrong here — losing a session is cheap — but it means the guidance is
   being knowingly bent, which is worth saying out loud rather than discovering in an interview.
2. **Be flexible about instance types and Availability Zones**, with "a good rule of thumb ... at least 10 instance
   types". One type in one zone is the worst case for capacity.
3. **AWS strongly discourages failing over to On-Demand** to handle interruptions or unavailability, for two reasons:
   it can drive interruptions for other Spot instances, and if a type-and-zone combination is exhausted for Spot, it
   may also be hard to obtain on demand.
4. `RunInstances` is explicitly **not** the recommended API, because it cannot mix instance types. For a workload that
   does not need autoscaling, the recommendation is **EC2 Fleet**, and the recommended allocation strategy is
   `price-capacity-optimized`.
5. **Stop-on-interruption exists**, and it fits this design unusually well — with a catch. It requires a `persistent`
   Spot request, or a `maintain` fleet. While stopped, only EBS is billed. And: *"Only Amazon EC2 can restart an
   interrupted stopped Spot Instance"*, which it does when capacity returns in the same zone for the same type.
6. **Rebalance recommendations** are an earlier signal than the two-minute notice, warning of elevated interruption risk.

Point 5's catch is the interesting one. A `persistent` request wants the instance running; this design wants it stopped
most of the month. Left in place overnight, EC2 would restart the instance at four in the morning the moment capacity
freed up, and the bill would quietly become the always-on row of [docs/costs.md](../costs.md).

The three goals are therefore in tension: capacity odds want many instance types; automatic mid-session recovery wants a
persistent request pinned to one type; and the cost model wants nothing requested at all between sessions.

## Decision

**The Spot request is part of the session lifecycle.** It is created when a session starts and destroyed when the session
ends. That single move resolves the tension.

| Phase | Action |
| --- | --- |
| Start | Create an **EC2 Fleet**, `maintain` type, `price-capacity-optimized`, across roughly ten instance types of one architecture in one Availability Zone, with **stop-on-interruption**. Attach the data volume, reconcile mods, start the container |
| During the session | An interruption stops the instance and EC2 restarts it when capacity returns — the session resumes with no human involved. Rebalance recommendations trigger an early world save |
| Idle stop | Save, archive, stop, then **delete the fleet**, so nothing can bring the instance back overnight |

Consequences of that shape, stated so they are not surprises:

- Deleting the fleet terminates the stopped instance. That is acceptable and already assumed: the world lives on a
  separate volume, and boot reconciles against the live release. See [ADR-0004](0004-ec2-spot-for-the-game-server.md).
- The instance is therefore **fresh every session**, not a stopped one being restarted. Cold start now includes a full
  boot, which matters because [ADR-0006](0006-on-demand-start-and-idle-shutdown.md) pays that cost nightly. Mitigated by
  a **baked AMI carrying Docker and the pinned server image** — but never the mods, which stay data reconciled from S3, so
  [ADR-0005](0005-containerised-game-server.md)'s reasoning is untouched.
- One architecture only. Ten types cannot span ARM and x86 with one AMI, so the ARM-or-x86 question in
  [ADR-0004](0004-ec2-spot-for-the-game-server.md) picks the fleet's architecture, and the ten types are chosen within it.
- One Availability Zone only, because the data volume is zonal. This knowingly gives up half of the recommended
  diversification, and it is the main residual capacity risk.

**Retracted from [ADR-0004](0004-ec2-spot-for-the-game-server.md): "fall back to on-demand for the same instance type".**
AWS discourages it, and the second reason is decisive here — if Spot capacity for that type and zone is exhausted,
on-demand for the same type and zone may be too, so it is not a reliable escape. The reliable mitigation is type
diversification, which is what this ADR buys. If on-demand is ever used deliberately, it should be a *different* type,
and the cost consequence in [docs/costs.md](../costs.md) accepted openly.

**No maximum price.** Setting one causes more frequent interruptions, and the Spot price is already far below on-demand.

## The risk that was underweighted

Everything written so far about Spot in this repository has been about interruption *mid-session*. The guidance makes
clear that the more likely nuisance is different: **capacity not being available when a session starts.** AWS gives no
guarantee of immediate availability, and a surge in On-Demand demand can exhaust a pool.

For this project that means the realistic bad evening is not "we got dropped at 23:40", it is "the server would not start
at 22:00". That is worse, because there is no world to rejoin and nothing to wait for. It is also exactly what type
diversification addresses, which is why this ADR exists rather than the simpler start-and-stop-one-instance approach.

The start operation must therefore report a capacity failure as a distinct, understandable outcome — "no capacity right
now, try again shortly, or ask the owner to switch types" — and not as a generic error. See
[ADR-0025](0025-step-functions-for-long-operations.md).

## Consequences

**Good**

- Follows the guidance where it is affordable to: many types, the recommended allocation strategy, the recommended API,
  no maximum price, both interruption signals used.
- Automatic mid-session recovery from an interruption, with no human action and no extra cost while stopped.
- Nothing is requested between sessions, so the cost model in [docs/costs.md](../costs.md) holds exactly.
- An early world save on the rebalance signal, which is more warning than the two-minute notice gives.
- Materially better odds of starting successfully at ten o'clock at night than a single instance type would give.

**Bad, or risky**

- More moving parts than starting and stopping one instance: a fleet created and deleted every session, and a launch
  template to keep correct.
- A fresh instance nightly means a longer cold start than resuming a stopped one, against the friction that is felt most.
- An AMI to build and maintain, which is a small pipeline of its own.
- Still one Availability Zone, so half the recommended diversification is unavailable while the volume is zonal.
- If the fleet is not deleted on stop, EC2 will restart the instance on its own and the bill goes to the always-on row.
  This is the single most expensive way for this design to fail.

**Mitigations**

- Fleet deletion is a step of the stop state machine, and the running-hours alarm in
  [ADR-0015](0015-observability-and-alerting.md) is the backstop that catches it if it fails. Treat an unexpected running
  instance as an incident, not a curiosity.
- A separate alarm on "a fleet exists while no session is active", which is a more direct signal than running hours.
- Bake Docker and the server image into the AMI, and rebuild that AMI only when the image tag or the base OS changes.
- Choose the ten types with the Spot placement score and the Spot Instance Advisor before the region is fixed, not after.

## Alternatives considered

| Option | Why not chosen |
| --- | --- |
| Start and stop one persistent Spot instance, as [ADR-0004](0004-ec2-spot-for-the-game-server.md) proposed | By far the simplest, and the fastest cold start, since a stopped instance resumes with a warm disk. One type in one zone is the worst configuration for capacity, and a capacity shortfall means no server that evening. Reconsider if capacity turns out to be a non-issue for the chosen type |
| `persistent` Spot request left in place permanently, with stop-on-interruption | Best mid-session behaviour with the least machinery. EC2 restarts the instance whenever capacity returns, including overnight, which converts the cost model into the always-on row |
| Terminate-on-interruption, and let the next explicit start relaunch | Simple and honest, and the state is already safe on the volume. Loses automatic mid-session recovery, so an interruption ends the evening rather than pausing it |
| On-demand for everything | No capacity risk and no interruptions. Roughly triples the compute line, at which point a flat-rate rented box is cheaper. See [docs/costs.md](../costs.md) |
| Auto Scaling group instead of EC2 Fleet | The recommended route when autoscaling is wanted. There is nothing to scale here — one instance, one world |
| `RunInstances` with a Spot market option | The obvious one-liner. Explicitly not recommended, because it cannot mix instance types, which is the whole point |

## Open questions

- The ten instance types, which depend on the architecture choice and on the memory figure from
  [docs/measurements.md](../measurements.md).
- Whether the fresh-instance cold start, with a baked AMI, is close enough to a stopped-instance resume. If it is much
  worse, the simpler mechanism may win despite the capacity risk — measure both before deciding.
- Whether stop-on-interruption's automatic restart can race the idle watchdog mid-session, and how the watchdog should
  behave while the instance is stopped but the fleet is still alive.
- Whether the rebalance recommendation should also warn players in chat, or only trigger a save. Probably only a save;
  a warning that often comes to nothing trains people to ignore it.

## Sources

Verified 2026-08-11.

- Best practices for EC2 Spot, including diversification, the discouragement of on-demand failover, and the API
  recommendation: <https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/spot-best-practices.html>
- Spot interruptions overview: <https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/spot-interruptions.html>
- Interruption behaviours, and the conditions under which EC2 restarts a stopped instance:
  <https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/interruption-behavior.html>
