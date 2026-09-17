# ADR-0054 — Place a session on a host with room, or launch one that fits

- Status: Proposed
- Date: 2026-09-17
- Milestone: later — after [ADR-0048](0048-one-instance-per-active-world.md)'s trigger has fired at least once
- Amends: [ADR-0048](0048-one-instance-per-active-world.md), which keeps the host created for the session, S3 as the
  world's home between sessions, the ten-minute waiting budget, the `cold`/`warm` policy and the verified-archive gate,
  and loses two sentences: "two worlds never share an instance" and "capacity is data, not a scheduler"
- Amends: [ADR-0033](0033-connectivity-as-a-strategy.md), whose address gains a port that belongs to the session's
  slot rather than to the game
- Relates: [ADR-0006](0006-on-demand-start-and-idle-shutdown.md) (the stop machine becomes two-level),
  [ADR-0051](0051-restart-a-session-without-releasing-the-host.md) (whose `keepHost` is the session-level stop),
  [ADR-0034](0034-per-game-adapter.md) (the adapter learns its slot), [ADR-0027](0027-spot-request-shape.md) (whose
  EC2 Fleet request this reuses for on-demand, and which stays deferred for Spot), [ADR-0014](0014-no-kubernetes.md)
  (still no cluster)

## Context

ADR-0048 answered "two groups want different worlds on the same evening" with one instance per world, and wrote down
why several worlds on one instance was left open rather than chosen: it breaks `session == instance lifetime`, needs a
two-level stop with a refcount, a port allocator and a capacity model, and puts every co-tenant behind one out-of-memory
kill. It also recorded that "no placement algorithm" was "the whole reason the decision is affordable".

The owner has now asked for the other thing: a session that knows how much it needs, goes onto a machine that has room,
and gets a new machine only when none has. The forces behind it are two.

**The bill for small games.** A Factorio server wants two gigabytes and a vanilla Minecraft three. Under ADR-0048 each
of them is a whole machine with a whole public address, so three small worlds on one evening cost three hosts. The
hosts are billed only while somebody plays, which keeps the fixed cost at nothing, but three of them cost roughly what
one machine with room for all three would.

**Where this goes if it is ever handed to more people.** The [README](../../README.md#non-goals) says this is not a
hosting product, and that stays true. But the shape that would make it one is a fleet of workers packed with many small
servers, and a fleet that terminates itself when the last one leaves. Recording the seam now, while the panel has
three games and one group, is cheaper than discovering it under load.

Three facts from the code make this smaller than ADR-0048 feared, and they were put there for it:

- The stop machine already has the session-level stop. ADR-0051's `keepHost` stops the session, archives the world and
  leaves the machine running. What is missing is the decision *after* it.
- The host-idle sensor already exists. `server/scripts/check-host-activity.sh` answers "is any other game service
  running here", fail-closed, and its own header names this ADR's question as the reason it was written.
- The lease and fencing discipline of Lifecycle V2 already gives conditional writes a home. A reservation on a host is
  the same kind of record as a lease on a lifecycle: a version, a conditional update, a conflict when two writers race.

Two facts from the measurements bound the design. A modded Minecraft with a 4 GiB heap reached about 6 GiB of container
memory, so the unit of placement is the container's memory limit, not the heap. And the same server used about 0.6 of
one core, with the main tick bound to one core, so memory is what fills a host first and cores are a weight rather
than a wall. The numbers live in [docs/measurements.md](../measurements.md) and the prices in
[docs/costs.md](../costs.md); this ADR restates neither.

Managed schedulers were considered as the way to avoid writing one. ECS on EC2 packs tasks by memory and launches and
terminates instances through a capacity provider; ECS Managed Instances does the same with AWS operating the machines;
Fargate removes the machines altogether. Each is recorded below with the reason it is not chosen today. The short
version: every one of them replaces the host-side contract this project has built — Compose files per game, scripts
driven over SSM, a data directory per world — with task definitions and a container-side agent, and that rewrite is
the expensive part. The placement decision itself does not grow with the fleet: best fit is one pass over the hosts
that have room, and a reservation is one conditional write. What does grow with the fleet is named in the decision,
so that nothing here has to be undone to grow.

## Decision

**A start places its session on the ready host that leaves the least room after taking it, and launches a host that
fits the session when no host has room.** Best fit, so tenants gather on few hosts and the rest drain. A launch asks
for the footprint beside the system reserve and nothing else — minimum memory, minimum cores, the architecture
[ADR-0032](0032-on-demand-single-instance.md) chose, no burstable types — as the `InstanceRequirements` of an EC2 Fleet
of type `instant` with the `lowest-price` strategy. EC2 answers with the cheapest instance that meets them at that
moment, synchronously, and the instance's type and size are recorded on the host as what it turned out to be.
**No list of instance types and no price lives in the control plane or the catalog.** Prices are AWS's data at launch
time; a shape catalogue that ranked them would be a copy of that data that goes stale, and a policy chosen by
reading it would be a decision made once about a number that changes weekly. This is what keeps an evening with one
world costing exactly what it costs under ADR-0048: the launch asks for what one world needs, so packing only ever
adds a tenant to a host that already exists.

**Headroom is the paid choice for a warmer fleet.** A session that lands on a host already up skips provisioning and
the image pull. A deployment that wants that for most starts sets a headroom target: while anything is running, the
fleet keeps at least that much memory free somewhere, launching for the shortfall and holding an empty host past its
grace period while it is the only room. When nothing runs, nothing is kept — the rule this whole system is built on.
The default is zero, and the setting is a cost with a name, like `warm` for a world. It replaces any notion of
launching "a bigger machine in case": the fleet never speculates on demand it has not seen.

**A world declares its footprint, and the footprint is a hard limit.** The catalog carries per world, defaulting per
game, a memory figure and a core weight. The memory figure becomes the container's cgroup limit, so a co-tenant's leak
is its own out-of-memory kill and nobody else's. The sum of footprints on a host never exceeds the shape's memory
less a fixed reserve for the system, and the sum of core weights never exceeds its cores less half of one. Cores are a
weight, not a pin: a tick loop on one core gains nothing from a pin and loses a neighbour's idle time.

**A slot is the port allocator.** Each reservation on a host takes the lowest free slot. Slot zero keeps the game's
own ports, and a session that arrives with no slot at all runs exactly as it did before this decision; every other
slot owns a window of ten ports in one host-wide range, the game port first, RCON second, any further port the game
publishes after, so two sessions on a host cannot collide whatever games they run and however many they are. A game
whose server tells its clients which port to continue on — Project Zomboid does — cannot yet take a slot other than
zero, and its module says so rather than letting a start find out. Nothing else allocates ports and no table records them. The adapter of
[ADR-0034](0034-per-game-adapter.md) reads its slot from the environment and binds accordingly, which is what dissolves
the `127.0.0.1:27015` obstacle ADR-0048 recorded: two Factorio worlds on one host bind two RCON ports. Each session is
its own Compose project, named for the world, so `check-host-activity.sh` counts projects rather than services.

**The address is the session's, and it carries a port.** ADR-0033's strategy still supplies the host part; the session's
slot supplies the port. Minecraft's Java client resolves `SRV` records, so the Route 53 strategy publishes one per
world and a player types a name. The overlay strategy has no `SRV`, and Factorio and Project Zomboid have no `SRV`
client, so those players see `host:port`, exactly as they see it today for slot zero. The panel and the bot already
show the address they are given.

**The stop is two decisions, not one.** A session stop is what ADR-0051 built: recheck players, save, archive, verify
the upload, take the session's containers down, then release its reservation. When the release empties the host, the
host starts **draining**: a grace period, ten minutes by default and configurable, during which a start may take the
host again and cancel the drain. When the period ends and the host is still empty, a conditional transition decides
what ADR-0048 already decided per world: **terminate** when every tenant was `cold`, **stop** when the last tenant was
a `warm` world. A stopped warm host keeps that world's data and is a candidate for that world's next start and for
nobody else's.

**Termination is still conditional on the verified archive.** A session whose stop cannot produce a verified upload
does not release its reservation, so the host it sits on cannot drain. The paid machine stays the cheaper half of the
trade, and the alarm on a host that survived a stop keeps its meaning: a world's only copy did not reach S3.

**The placement record lives beside the lifecycle record.** One item per host in the same table: shape, state, the
reservations with their slots and footprints, a drain timestamp, a kept-world id and a version. Every transition is a
pure function in `lambdas/src/domain/placement.ts`, applied with a conditional write on the version. Two starts that
race for the last gigabyte both compute a fit; one write lands; the other re-reads and places again. Two starts that
both find nothing and both launch a host is accepted: the second host drains ten minutes after its first session ends,
and the cost of that is ten minutes of a small machine.

**Nothing in the mechanism depends on the size of the fleet.** The same start, the same reservation and the same drain
serve one group's evening and a fleet of workers for many groups; what changes with size is data and settings, and it
is listed here so that growing changes neither the decision nor the code that carries it.

| At a larger fleet | What changes | What does not |
| --- | --- | --- |
| Reading the hosts | Hosts are read by state, which becomes an index rather than a pass over the table | The placement over the hosts read |
| Many starts at once | The module ranks every host with room; a start that loses the conditional write takes the next candidate rather than reading again | One write wins per gigabyte |
| Packing quality | A running game server cannot move, so packing is arrival order plus drains, here and in every managed scheduler; headroom keeps room for arrivals to gather in, at a cost the deployment chose | Best fit |
| The bill | The same launch request with a Spot target capacity per [ADR-0027](0027-spot-request-shape.md) is how a busy fleet gets cheap; prices never enter this code either way | The drain, the footprint, the verified archive |
| The ceiling | The region's vCPU quota and the public addresses per host, raised and counted ahead of the fleet, as ADR-0048 already requires | Nothing in this ADR caps the number of hosts or of sessions on one |
| Empty hosts | One drain execution per empty host, however many | The grace period and the conditional decision |

**Not decided here, and recorded so it is not rediscovered.** Spot stays deferred with [ADR-0027](0027-spot-request-shape.md);
its two-minute notice is a forced session stop and nothing in this ADR makes it harder. Fargate for small
self-authenticating games is where a world goes once it leaves the overlay, and this decision moves towards it by
putting every session in its own network namespace. What a fleet for many groups adds on top of this mechanism —
tenancy, billing, support — is a product question this repository does not answer.

## Consequences

**Good**

- Small games share a host: a Factorio and a vanilla Minecraft beside a modded one cost one machine, not three, and one
  public address, not three.
- One world on one evening costs what it costs today. There is no host that exists because somebody might join.
- A stop followed by a start within ten minutes reuses the warm Docker cache and the machine, which is the restart
  case of ADR-0051 without a special path.
- Everything host-side survives: Compose files, SSM-driven scripts, the data directory per world, the idle watchdog per
  session, the verified archive. The host-idle sensor and `keepHost` stop being seams and start being used.
- The placement is pure code with tests, so a bad decision is reproducible on a laptop before it is reproducible on a
  bill.

**Bad, or risky**

- **Co-tenants share cores.** Memory is fenced; CPU is not. A tick-heavy modded world beside another can lose tick time
  to it. The core weight bounds how many share, and does not guarantee anything. Accepted for a group of friends;
  unacceptable for paying strangers, which is one reason the commercial fleet is a different product.
- **A host-level failure takes every session on it.** An instance that dies loses several sessions, not one. Each
  session still archived at its last stop and the watchdog still saves on idle, so what is lost is the play since the
  last save, times the number of tenants.
- **A drain is ten minutes of a billed machine after the last stop.** Per host, per evening. It is variable cost tied
  to play, never fixed, and the period is a number.
- **Two starts may launch two hosts where one would do.** Accepted above; the residue is one drain.
- **Ports are visible for UDP games and on the overlay.** They are visible today; what changes is that slot one shows a
  port a player has not seen before.
- **The single-instance assumptions ADR-0048 listed grow one more place**: the Prometheus and Grafana stack is per host
  and must scrape several sessions.

**Mitigations**

- Measure co-tenancy before it is the default: two modded worlds on one `r7i.large` with both groups on, milliseconds
  per tick recorded for each. The measurement decides whether the modded footprint's core weight is one or two, and
  that alone decides how many share a host.
- Keep the per-session watchdog and the per-session archive exactly as they are; they are what bound the blast radius
  of a host failure.
- Extend the running-hours alarm to any host carrying the project tag, and add one for a host in `draining` longer than
  its grace period, which is the signal that the drain machine did not run.
- Keep headroom at zero by default, so a warmer fleet is a choice with its cost attached rather than a surprise on a
  quiet evening; the replay in [docs/costs.md](../costs.md) shows what a gigabyte of it costs an evening.
- Preview what a launch request would match with `GetInstanceTypesFromInstanceRequirements` when the allowed families
  change, so a requirement nothing satisfies is found in a check and not at ten o'clock.

## Alternatives considered

| Option | Why not chosen |
| --- | --- |
| Keep ADR-0048: one instance per world | Correct until small games share an evening. It stays the behaviour whenever nothing has room, so nothing is lost by building on it rather than beside it |
| A shape catalogue in the control plane, ordered by price | The first draft of this ADR. It copies a number AWS owns into data that goes stale, and it turns "which machine" into a policy a person picks by reading a table. EC2 Fleet's attribute-based selection answers the same question at launch time with the current price |
| ECS on EC2 with a capacity provider and managed scaling | Does the packing and the fleet sizing. In exchange: the host contract becomes task definitions and a container-side agent, scale-out from zero launches two instances by design, scale-in waits fifteen minutes on a CloudWatch alarm, and a second scheduler's placement has to be reasoned about beside the control plane's own leases. Its packing is the same best fit this ADR writes down, so fleet size alone does not decide for it; what would is wanting what it adds beyond placement — task health and restarts, an agent AWS maintains, capacity it operates — at a moment the host contract is being rewritten anyway |
| ECS on EC2 with the control plane sizing the fleet | Removes the two-instance and fifteen-minute behaviours and keeps ECS as the packer. Still pays the host-contract rewrite, for a placement decision this small |
| ECS Managed Instances | AWS operates and consolidates the machines for a per-instance fee, available in `eu-central-1` since late 2025. Whether a task on it can carry its own public address, and which network modes it allows, was not verified while writing this; it is the alternative to re-read first when the fleet grows |
| Fargate, one task per world | Pays per world-hour with no packing to get wrong, and every task owns its address and ports. Blocked today by the overlay client's `tun` device and by the SSM-driven host scripts, and its cores are not chosen for a single-threaded tick. Where a small self-authenticating world goes once it leaves the overlay |
| Nomad, Agones, Kubernetes | A running scheduler is an always-on component, which [docs/architecture.md](../architecture.md) refuses component by component, and a cluster control plane is the trap [docs/costs.md](../costs.md) names first |
| A persistent shared host that stays up between sessions | A fixed cost, the one number this project keeps at nothing |

## Open questions

- **Tick time under co-tenancy**, two modded worlds on one host with both groups on. Decides the modded core weight.
- **The measured cold start of a created host**, still open from ADR-0048, and now also the start of a second session
  on a warm host, which should be close to the two minutes of a stopped machine.
- **The grace period.** Ten minutes is a guess that is shorter than the idle window and longer than a restart. The
  simulation in `lambdas/prototype/placement-evening.ts` shows what a minute of it costs; the right number comes from
  watching how often a start follows a stop.
- **`SRV` on the overlay.** ZeroTier's managed DNS may or may not carry `SRV` records; if it does, Minecraft players on
  the overlay also type a name.
- **Which surface tells a player a port**, and how the bot's `/address` shows two worlds on one host.
- **The system reserve** of one gigabyte and half a core: a guess to be measured against the observability stack and
  the overlay client on a small shape.
- **Project Zomboid on a slot other than zero.** Its server announces a second UDP port to clients, so a slot's host
  mapping would send them to a port nothing listens on. Rendering `DefaultPort` and `UDPPort` into the server's ini
  from the slot is what lifts it; until then a Zomboid world takes slot zero or its own host.
- **The fleet host's bootstrap.** A launched host checks this repository out at first boot, renders its runtime
  environment from Parameter Store and authorises itself on the overlay through the Central API. Written from the
  references and not yet run against AWS; the acceptance phase of the rollout is where it is.
- **The allowed families.** ADR-0032 chose x86 and single-thread performance; the requirements can name families
  (`AllowedInstanceTypes`) and generations but cannot say "fast cores" directly, so the list of allowed families is
  the one piece of type knowledge left in data, and it is a filter rather than a ranking.
