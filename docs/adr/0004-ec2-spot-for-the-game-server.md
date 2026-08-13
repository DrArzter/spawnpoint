# ADR-0004 — Run the game server on EC2 Spot

- Status: **Superseded by [ADR-0032](0032-on-demand-single-instance.md)**
- Date: 2026-08-11
- Superseded: 2026-08-13
- Milestone: M0
- Amended by: [ADR-0027](0027-spot-request-shape.md) — the request mechanism below was replaced, and the on-demand
  fallback **retracted** as contrary to AWS guidance. That ADR is itself deferred

> **Everything below is history.** The project runs **on-demand** on `r8i.large` — see
> [ADR-0032](0032-on-demand-single-instance.md), which carries forward the parts still in force: public subnet with no
> NAT Gateway, x86 over Graviton, single-thread performance as the selection criterion, and compute separated from
> state.
>
> Kept unedited because the reasoning is worth reading — why a game server tolerates interruption unusually well, and
> why serverless containers do not fit a process holding a large heap on a fast local disk. Both survive the change of
> purchase model. The measurements that accumulated in the open questions below now live in
> [docs/measurements.md](../measurements.md).

## Context

A modded server needs a lot of memory — 8–16 GB is normal for a large pack — and good single-thread
CPU performance, because the main game tick is effectively single-threaded. It runs for a few hours on
a few evenings a week, so utilisation is roughly 5–10% of the month.

Spot instances give a large discount on identical hardware, in exchange for reclamation with a
two-minute warning. A game server tolerates that unusually well: the world lives on a separate
volume, players can rejoin, and losing a session is annoying rather than serious.

Serverless containers fit the intermittent pattern, but Minecraft wants a long-lived process holding a
large heap, a stable port, and a persistent volume with fast local I/O. Chunk loading is I/O heavy, so
network-attached shared storage is a poor fit.

## Decision

Run the game server on a single EC2 Spot instance in a public subnet, with a persistent EBS data
volume that outlives the instance.

Design for interruption from the first day: the world is on the data volume, the two-minute
interruption notice triggers a world save and a clean container stop, and the next start reattaches the
same volume.

Prefer ARM (Graviton) if the mod set runs on it, otherwise x86.

## Consequences

**Good**

- The largest single cost reduction in the design, and it multiplies with not running at all when idle.
- Interruption handling forces a clean separation of compute from state, which is the right design
  regardless and the part that transfers to real work.
- A public subnet with no NAT Gateway removes a fixed monthly cost that would otherwise exceed the
  compute cost.
- Local EBS gives predictable chunk-load performance, and volume snapshots are a cheap backup primitive.

**Bad, or risky**

- An interruption mid-session drops the players, and the world reverts to the last save.
- Spot capacity for a given instance type in a given availability zone can be unavailable.
- The EBS volume is tied to one availability zone, so it constrains where the instance can launch.
- The instance is directly reachable from the internet, so the security group is the only network
  boundary.

**Mitigations**

- Frequent autosave, plus an explicit save on the interruption notice.
- Allow several instance types within one zone — around ten, per AWS guidance. A zone change means restoring from an
  S3 backup instead of reattaching, so the zone stays fixed. See [ADR-0010](0010-world-persistence-and-backups.md)
  and [ADR-0027](0027-spot-request-shape.md).
- ~~If capacity fails, fall back to on-demand for the same type.~~ **Retracted.** AWS discourages failing over to
  on-demand, and decisively so here: if Spot capacity for a type and zone is exhausted, on-demand for the same
  combination may be too. Type diversification is the real mitigation. See [ADR-0027](0027-spot-request-shape.md).
- The security group opens the game port only, with no SSH port at all. See [ADR-0007](0007-ssm-instead-of-ssh.md).
- Switching to on-demand remains possible as a deliberate, costed choice — but with a *different* instance type, and it is not the answer to a capacity shortfall. See [ADR-0027](0027-spot-request-shape.md).

## Alternatives considered

| Option | Why not chosen |
| --- | --- |
| On-demand EC2 | Simpler and never interrupted, but several times the hourly rate for identical hardware. Available as a deliberate, costed choice — no longer described as the fallback for a capacity shortfall, per [ADR-0027](0027-spot-request-shape.md) |
| Reserved Instance or Savings Plan | Needs a one or three year commitment for a workload that runs about 5% of the time. Wrong instrument |
| ECS Fargate, as in the prior art | Fits intermittent work and removes host management, but costs more per GB of memory, pushes the world onto EFS, and hides the capacity and lifecycle problems this project wants to learn. See [ADR-0003](0003-build-not-reuse.md) |
| Lightsail | Predictable flat price, but billed monthly, so stopping the server saves nothing |
| Lambda | Hard execution time limit. Not applicable to a persistent game server |

## Open questions

- ~~Instance type.~~ **Settled 2026-08-12: `r8i.large`** — 2 vCPU, 16 GiB, x86_64, on-demand at a quoted
  **$0.16758 per hour**. Chosen over the cheapest comparable option, `r5a.large` at $0.137, because the whole
  current-generation spread is only $0.137 to $0.193 — about $4 a month — so instance choice is not where the money is,
  and the criterion below says take the fastest thread rather than the cheapest hour. `r8i` is the newest Intel
  generation available. Older generations such as `r5a`, `r5b` and `r5d` stay useful as fleet members if Spot is ever
  adopted, because lower demand means better capacity.
- **A note on the naming, since it is opaque.** `r8i.large` reads as family `r` (memory optimised, 8 GiB per vCPU),
  AWS generation `8` — AWS's own numbering, unrelated to Intel's — processor `i` for Intel, `a` for AMD, `g` for
  Graviton, and size `.large`. Suffixes `d`, `n` and `b` add local NVMe, network and EBS bandwidth respectively; **all
  three are a waste here.** In particular `d` pays for an instance store that is wiped on stop, and this design stops
  the instance nightly while the world lives on EBS.
- Instance size. Operator experience gives a bracket — 2 cores and 4 GB often enough, 4 cores and 16 GB runs anything
  comfortably — but **that was measured on an i9-14900KF**, and only half of it transfers.
  - **Memory transfers.** A gigabyte is a gigabyte — but the bracket was about the *JVM heap*, and the instance has to
    hold more than the heap. Measured 2026-08-12: with one exploring player, container-accounted memory reached
    **5.863 GiB against a 4 GiB heap**, so roughly 1.9 GiB above it. On an 8 GiB instance that leaves about 2 GiB for
    the OS, Docker, the overlay agent and any growth — with a single player online. **So the starting size is 16 GiB**,
    and 8 GiB becomes a downsize candidate once the full group has been measured, rather than an optimistic default.
    See [docs/measurements.md](../measurements.md).
  - **The CPU figure does not.** A 14900KF P-core is among the fastest single threads available anywhere; a cloud
    server core is materially slower per clock and clocked lower. "Two cores' worth" on that machine is more than two
    cloud vCPUs of the same work.
- **This is the risk that could make the whole thing feel bad**, and it is not fixable with a bigger instance. The main
  tick is effectively single-threaded, so it cannot be spread across cores. If the tick needed most of one 14900KF core,
  no number of slower cores will hold 20 ticks per second — the server will lag while showing plenty of idle CPU. Cores
  beyond the second buy chunk generation and I/O headroom, not tick headroom.
- Therefore: **single-thread performance is the primary selection criterion, not a refinement.** Newest generation
  available, and the families with the highest clocks rather than the widest instances. This shapes the ten-type list in
  [ADR-0027](0027-spot-request-shape.md), and it narrows it, because the fast families are a smaller set.
- **And the family shape follows from the same measurement: memory binds, cores do not.** The sampled CPU figure was
  0.19 of one logical CPU. Wanting 16 GiB from a general-purpose family means an `.xlarge` and four vCPUs, three of
  which go unused; a **memory-optimised `.large` gives 2 vCPU and 16 GiB** for less. So the ten types should be
  `r`-family `.large` sizes across the fastest available generations, not `m`-family `.xlarge`.
- **It also reopens the ARM question below, as a genuine trade rather than a free discount.** Graviton is cheaper per
  hour and slower per core; for a single-threaded tick the cheaper core is not automatically the cheaper answer.
- The only honest resolution is to measure **milliseconds per tick under real load on a candidate instance** — not
  locally, where a desktop or Apple Silicon core flatters the result the same way the 14900KF does. Under about 50 ms
  per tick is healthy; above it, players feel it. This belongs in M0.

**Accepted risk, not a gate.** The tick figure is recorded, not blocked on. If it turns out poor, the escalation is
ordinary and cheap: step up one size, then change to a higher-clocked family, then decide whether it is good enough
anyway. A five-player server that occasionally stutters is a nuisance, not a failure — and the deliverable here is the
pipeline and the lifecycle, not a competitive tick rate. If somebody genuinely needs guaranteed smoothness, the answer
is to pay for hardware that provides it, and that is a purchase rather than a redesign.
- ~~Whether the mod set runs on ARM.~~ **Settled as x86, without testing.** The Graviton saving is 15–20% of a compute
  line of about $3.40, so under a dollar a month, against a core that is slower where this workload is most sensitive.
  With Sinytra Connector bridging Fabric mods, an architecture problem would most likely appear as a subtle failure
  under load rather than a clean refusal to start. Not worth the risk for the prize.
- ~~Whether to use a Spot request with a capacity-optimised strategy, or simply start and stop one
  persistent Spot instance.~~ Answered in [ADR-0027](0027-spot-request-shape.md): an EC2 Fleet created per session,
  diversified across about ten instance types, with `price-capacity-optimized` and stop-on-interruption.
