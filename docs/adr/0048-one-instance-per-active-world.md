# ADR-0048 — One instance per active world, created for the session

- Status: Proposed
- Date: 2026-09-14
- Milestone: later — the trigger is two groups wanting different worlds on the same evening
- Amends: [ADR-0023](0023-multiple-worlds.md), which keeps its world entity, its storage layout and its
  release lineage, and loses only "one of them active at a time"
- Amends: [ADR-0032](0032-on-demand-single-instance.md), which keeps on-demand purchasing, the instance family and
  the separation of compute from state, and loses "one instance" as a fixed number
- Amends: [ADR-0006](0006-on-demand-start-and-idle-shutdown.md), whose stop machine this decision deliberately does not
  touch, and whose recorded premise that "1 to 3 minutes is tolerable" is widened to ten by the owner on 2026-09-14
- Relates: [ADR-0010](0010-world-persistence-and-backups.md) (the backup that becomes load-bearing),
  [ADR-0033](0033-connectivity-as-a-strategy.md) (which already supplies the per-world address), and
  [ADR-0043](0043-deploy-production-from-reviewed-pull-requests.md) (whose owner gate is the reason the fleet is not
  declared in Terraform)

## Context

The repository says one instance because the group is one group and plays one world at a time. That assumption is
written into three places, and only three: the unconditional `StopInstances` after a session stop, the single Lifecycle
V2 item, and instance resolution as a singleton. The last one is visible to players as `host_not_unique`, which reads
like a scheduling error and is in fact an assertion: the tag filter in `listHosts()` must return exactly one machine.

The trigger has a shape. Two groups want different worlds on the same evening, and today one of them waits. Nothing
else about the design objects: worlds already own their releases, their wipes and their backup lineages, the session
machines already take a world id, and [ADR-0033](0033-connectivity-as-a-strategy.md) already makes the address a
per-world property produced by a strategy rather than a configured string.

Two objections used to stand in the way, and both have answers now.

**The fleet size is not a cost.** Machines that exist only while somebody plays cost nothing when nobody does, so
whether the fleet holds one machine or ten is not a design parameter. What does cost money is a *persistent volume per
world*, and that is a separate choice about where world data lives, made below.

**The overlay's device ceiling is not a ceiling on worlds.** ZeroTier's free tier allows ten devices, and a concurrent
host would consume one each. [ADR-0033](0033-connectivity-as-a-strategy.md) already defines a Route 53 strategy, and
[`infra/terraform-domain`](../../infra/terraform-domain) already owns a delegated public zone whose README anticipates
a record for the game. A world published through DNS consumes no overlay slot.

That second answer carries a condition, and it is the important sentence in this ADR: **a DNS address is not a gate.**
ADR-0033's invariant refuses the silent pairing of a world that authenticates nobody with a strategy that restricts
nobody. Moving a world off the overlay therefore remains a per-world decision that needs either a game that
authenticates its own players, or an explicit `auth: external` declaration from the operator. It does not follow from
this ADR, and this ADR does not weaken it.

## Decision

**A session runs on its own instance, and the fleet is however many sessions are running.** Zero instances when nobody
plays; one per active world otherwise. The count is an outcome, never a configured number.

**The instance is created for the session and terminated at the end of it.** Terraform owns the durable shapes: the
launch template, the AMI, the security group, the instance profile and the tags. The control plane calls `RunInstances`
at start and terminates at stop. It does not call an apply.

| | |
| --- | --- |
| Selection | The instance tagged `World=<world id>`, not the one instance in the account |
| Fleet definition | A launch template, not a `for_each` over the catalog |
| Shape | A per-world field in the catalog, defaulting to the current `m7i-flex.large` |
| Session policy | A per-world field: `cold` terminates the instance at stop, `warm` leaves it stopped. Default `cold` |
| World data | Restored from S3 at start; a `cold` world holds no state that outlives the session |
| Address | The world's connectivity strategy ([ADR-0033](0033-connectivity-as-a-strategy.md)), one record per world |
| Lifecycle record | Keyed by world, not a single item |
| Concurrency rule | One session per world. Two worlds never share an instance |

**Capacity is data, not a scheduler.** "Choose a machine with enough capacity" reduces to "launch the shape this world
names" once a world never shares a host. There is no placement algorithm to write, no port allocator, no per-host
refcount, and no capacity model beyond one catalog field. This is the whole reason the decision is affordable.

**S3 is where a world lives between sessions.** Start restores the current generation; stop saves, archives, uploads
and only then releases the machine. [ADR-0010](0010-world-persistence-and-backups.md) already built that path, and it
already verifies twice: `upload-world-backup.sh` runs `verify-archive.sh` before the upload and confirms the stored
object's checksum afterwards, under a script that aborts on either failure. This decision promotes that path from
insurance to the normal route. In exchange, no volume is billed for a world nobody is playing, and a session can start
in any availability zone.

**Ten minutes of waiting is the budget, and it is what makes this affordable.** The owner set it on 2026-09-14:
a group will wait for a server if waiting is what keeps the bill at nothing, and somebody who wants a world ready at
all times can pay for that world to be ready. Every other choice in this ADR follows from that sentence. The measured
start from a stopped machine is about two minutes; a created machine adds instance provisioning, a package install, an
image pull and a restore, none of which is measured yet and none of which needs to be fast to fit inside ten.

**A world names its session policy, and the default is cold.**

| Policy | Between sessions | Cost while nobody plays | For |
| --- | --- | --- | --- |
| `cold` (default) | The instance is terminated; the world lives in S3 | Only its archives, cents a month | Every world, unless somebody asks otherwise |
| `warm` | The instance is stopped and keeps its volumes | Its root and data volumes, a couple of dollars a month | A world whose group wants it up in two minutes and accepts the line |

This is the same machinery in both cases: create on first start, and decide at stop whether to terminate or to stop.
The policy is a catalog field next to the shape, so the person who wants an always-ready world is choosing a cost
rather than arguing for an architecture.

**Termination is conditional on that verified archive, and nothing else.** Today a stop that fails still leaves the
world on a volume, so a failed backup costs a retry. With a machine that is terminated, the same failure would cost the
world. So the rule is explicit: an instance is terminated only after the stop reports a verified upload. A stop that
cannot produce one leaves the instance stopped, keeps its volume, and raises an incident. The paid machine is the
cheaper half of that trade.

**The stop machine does not change.** The equation `session == instance lifetime` is what [ADR-0006](0006-on-demand-start-and-idle-shutdown.md),
the idle watchdog and the session cap are built on, and one world per instance keeps it exactly true. This is the
difference between this decision and its same-host sibling, which breaks that equation and is therefore not chosen
here.

**Several worlds on one instance is explicitly not decided here.** It remains the cheaper bill and the deeper change,
and it stays available: nothing in this ADR forecloses it. Two concrete obstacles are recorded so the next reader does
not rediscover them. Factorio and Project Zomboid both bind `127.0.0.1:27015` for RCON today, which only works because
one game's compose file is up at a time. And Minecraft's Java client resolves `SRV` records, so a non-standard port can
hide behind a name, while Factorio and Project Zomboid are UDP and would show players a port.

## Consequences

**Good**

- Two groups play different worlds on the same evening, which is the trigger this answers.
- The stop machine, the idle watchdog, the session cap and the running-hours alarm all keep working unchanged, because
  each instance still runs exactly one session.
- Nothing is billed while nobody plays: no stopped instances, no idle volumes.
- A world's blast radius is its own instance. An out-of-memory kill cannot take a neighbour's session with it.
- Preview environments ([ADR-0029](0029-preview-environments.md)) and production stop being different shapes, since a
  preview already restores a world copy onto a machine created for it.
- A later move to a managed scheduler gets easier rather than harder. Once a world is published through DNS, the host
  no longer needs a tun device and `NET_ADMIN` for the overlay client, which is today the concrete reason a container
  service could not run these servers.

**Bad, or risky**

- **Cold start gets worse, and [ADR-0032](0032-on-demand-single-instance.md) counted the warm disk as a benefit.** A
  created instance has no Docker layer cache and no world on disk, so a start pays an image pull and a restore that a
  stopped instance did not. Accepted rather than mitigated: the ten-minute budget above is what pays for it, and a
  world that cannot accept it sets `warm`. The number still has to be measured, because accepting ten minutes is not
  the same as accepting whatever it turns out to be.
- **The backup becomes the only copy.** With no surviving volume, the verified upload is the whole safety net, which
  is why termination is gated on it above. The residue of that gate is a stopped instance nobody is playing, which is a
  bill that needs noticing.
- **New failure modes at start**: a `RunInstances` refusal, an account vCPU quota that a tenth concurrent machine
  reaches, and an availability-zone capacity error. Today a start can only fail on a machine that already exists.
- **Public IPv4 is charged per address per hour**, so several concurrent worlds multiply a line that is currently one
  address.
- **More surface for a stuck instance.** A terminate that silently fails leaves a billed machine with no session
  attached to notice it.
- SSM registers and deregisters a managed instance per session, which makes the inventory churn
  ([ADR-0007](0007-ssm-instead-of-ssh.md)).

**Mitigations**

- Measure the created-machine start before this ADR moves to Accepted, on a world that does not exist yet, to the same
  Docker-healthy boundary the current measurements use. Baking the game images into the AMI is the lever if the number
  lands badly, and it is an optimisation now rather than a prerequisite.
- Keep the verified-backup gate on stop exactly where it is, and alarm on an instance that survived a stop, since
  under this decision that is the signal that a world's only copy did not reach S3.
- Raise the region's vCPU quota before the fleet can reach it, and give a refused `RunInstances` a message a player can
  act on rather than a stack trace.
- Extend the running-hours alarm from one instance to any instance carrying the project tag, so an orphan is still
  visible.
- Keep the session cap per instance. It is the backstop that survives every failure of the watchdog.

## Alternatives considered

| Option | Why not chosen |
| --- | --- |
| Declare the fleet in Terraform with `for_each` over the catalog | Describes a static parc: the machines and their volumes exist whether or not anyone plays, and creating a world becomes an infrastructure apply behind the owner gate of [ADR-0044](0044-apply-github-identities-behind-an-owner-gate.md). Terraform still owns the launch template, which is the durable part |
| A persistent EBS data volume per world, attached at start | Keeps the warm disk and the current restore path. Bills every world every month whether or not it is played, pins a world to one availability zone, and adds attach and detach failure modes to start and stop. Available per world as the `warm` policy, and refused as the default |
| Several worlds on one instance | The cheaper bill and the deeper change. Breaks `session == instance lifetime`, needs a two-level stop with a refcount, a port allocator and a real capacity model, and puts every co-tenant behind one out-of-memory kill. Left open, not rejected |
| ECS on EC2 with a capacity provider | Supplies the placement algorithm this decision deliberately does not need, and in exchange introduces a cluster, task definitions and a second scheduler to reason about |
| Fargate | Removes host management entirely. Blocked today by the overlay client's tun requirement and by EBS-backed world data, and it prices a playing hour higher. Reachable later, and this decision moves towards it rather than away |
| Keep one instance and make the second group wait | The status quo, and correct until the trigger fires. It is a queue whose length is a group of friends on a Friday |

## Open questions

- **Measured cold start** on a created machine, against the ten-minute budget. The estimate is four to eight minutes
  without a baked AMI and about three and a half with one, and an estimate is not a measurement.
- **Which surface owns the world-to-instance lookup.** The bot's single `INSTANCE_ID` becomes a world argument, and the
  workflows' IAM must scope mutations by tag rather than by one instance ARN.
- **What a start says when capacity is refused.** A quota or an availability-zone error is a new class of answer for a
  player, and the panel and the bot both need a sentence for it.
- **Whether the overlay stays the default.** Nothing forces a world onto DNS, and the invariant of
  [ADR-0033](0033-connectivity-as-a-strategy.md) means a no-auth world may not move without a declaration. The ten-slot
  ceiling binds only worlds that stay on the overlay.
- **Record TTL and client caching per game**, since a created instance takes a new address every session.
