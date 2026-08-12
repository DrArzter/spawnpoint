# ADR-0004 — Run the game server on EC2 Spot

- Status: Accepted
- Date: 2026-08-11
- Milestone: M0
- Amended by: [ADR-0027](0027-spot-request-shape.md) — the decision to use Spot stands; the request mechanism is
  replaced, and the on-demand fallback below is **retracted** as contrary to AWS guidance

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

- Instance family and size. Depends on the pack and player count. Start at roughly 4 vCPU and 16 GB,
  then measure tick time and memory headroom.
- Whether the mod set runs on ARM. Most Java mods do; some native libraries do not.
- ~~Whether to use a Spot request with a capacity-optimised strategy, or simply start and stop one
  persistent Spot instance.~~ Answered in [ADR-0027](0027-spot-request-shape.md): an EC2 Fleet created per session,
  diversified across about ten instance types, with `price-capacity-optimized` and stop-on-interruption.
