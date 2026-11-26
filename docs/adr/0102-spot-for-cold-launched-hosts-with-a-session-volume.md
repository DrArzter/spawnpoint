# ADR-0102 — Spot for cold launched hosts, with a session volume

- Status: Proposed
- Date: 2026-11-26
- Milestone: M6
- Amends: [ADR-0027](0027-spot-request-shape.md) — takes it out of deferral with a simpler request shape
- Builds on: [ADR-0054](0054-place-a-session-on-a-host-with-room.md), [ADR-0010](0010-world-persistence-and-backups.md)

## Context

ADR-0027 deferred Spot because the saving was about $8 a month for one 16 GiB host and the machinery was large. Two
things changed.

1. **The launch already has the right shape.** A launched host is started by an EC2 Fleet of type `instant` with
   `InstanceRequirements` built from the session footprint ([ADR-0054](0054-place-a-session-on-a-host-with-room.md),
   `workflows/start-server-v2.asl.json.tftpl`). EC2 chooses the type. Spot is the same request with a different target
   capacity type, not a new mechanism.
2. **The prices favour Spot more than the deferral assumed.** Read on 2026-11-26 in `eu-central-1`:

| Type | vCPU / GiB | On-demand $/h | Spot $/h |
| --- | --- | --- | --- |
| m7i-flex.large (in use) | 2 / 8 | 0.115 (from the bill) | about 0.05 |
| r7i.large | 2 / 16 | about 0.17 | about 0.071 |
| m6i.xlarge | 4 / 16 | about 0.23 | about 0.095 |

The Spot placement score for one 16 GiB host was 9 of 10 in all three zones. A host twice the current size costs less on
Spot than the current host costs on demand. Prices and scores move; these are one reading, not a measurement.

Today a launched host keeps the world on its root volume, which is deleted with the instance. An interruption therefore
leaves two minutes to save and upload every world on the host to S3. A large world, or several worlds on one host, may
not fit in that time.

## Decision

### Which hosts run on Spot

- Only **launched** hosts whose sessions are all `cold`. A Spot instance from an `instant` fleet cannot be stopped, only
  terminated, and a drain that ends in a stop ([ADR-0054](0054-place-a-session-on-a-host-with-room.md)) needs a stop.
  A host that takes a `warm` session is launched on demand, as now.
- A game declares `capabilities.spot` in `game.json` ([ADR-0088](0088-a-game-declares-its-facts-once.md)). Absence means
  `false`. A session of a game without it is placed only on an on-demand host. A game where an interruption loses work
  the game cannot save (for example a raid in progress) leaves it off.
- A repository variable switches Spot on. It is off by default, and off means byte-identical launches to today.

### The request

- `DefaultTargetCapacityType: spot`, `SpotOptions.AllocationStrategy: price-capacity-optimized`, no maximum price, and
  the same `InstanceRequirements` as today. The allowed families stay a Terraform variable.
- **On-demand as a last resort.** If the Spot request fails for capacity, the workflow makes the same request on demand.
  AWS discourages this ([ADR-0027](0027-spot-request-shape.md), point 3). It is accepted knowingly: this is one
  instance per evening, so its effect on other Spot users is negligible, and the alternative is no server that evening.
  The host records which market it came from.

### The session volume

- Every session on a Spot host gets its own EBS volume, created in the host's Availability Zone after the fleet answers,
  with `DeleteOnTermination` false and a tag naming the session. The world is restored from S3 onto it, and the game
  runs from it.
- When the session stops normally, the world is archived to S3 as now and the volume is deleted.
- The volume key gets one builder, as `AGENTS.md` requires for a new storage key shape.

### An interruption

1. **On the host.** A watcher reads `spot/instance-action` and the rebalance recommendation from instance metadata. On the
   two-minute notice, for every session on the host: `game_announce` (a new optional hook) with a countdown, then
   `game_save` to the session volume, then a report to the control plane. Nothing is uploaded to S3 on this path. A
   rebalance recommendation only triggers a save.
2. **In the control plane.** An EventBridge rule on the interruption warning marks each session on the host as moving.
   The idle watchdog ignores a moving session. The allocator places the sessions again **in the same Availability
   Zone**, and the new host attaches the existing session volumes. The world address does not change. Telegram and the
   panel say that the world is moving and when it is back.
3. **When the zone has no capacity.** The sessions are placed in another zone from a snapshot of each session volume,
   or from the last S3 backup if a snapshot cannot be made. Periodic backups to S3 stay, as the last line, not the
   critical path.

### Orphaned volumes

A volume whose session is not live is deleted by a sweeper, and an alarm fires if one survives a sweep. A volume left
behind is the most likely way for this design to cost money it should not.

## Consequences

**Good**

- About 55–60% less compute for the same host, or twice the memory for less than today's bill.
- An interruption costs a save to a local disk, not an upload against a deadline, so the number and size of worlds on a
  host do not decide whether the save succeeds.
- The session volume separates the world from the machine for on-demand hosts too, and makes a later seamless move
  (for example Minecraft's transfer packet) possible.

**Bad, or risky**

- A move is pinned to one zone while the volume lives there. The other zones are reached only through a snapshot or S3.
- More moving parts: a volume per session, a watcher on the host, an EventBridge rule, a sweeper.
- An interruption still disconnects the players for the length of a launch, a volume attach and a game start.
- On-demand as a fallback departs from AWS guidance.
- Warm worlds gain nothing until a stoppable Spot shape is chosen.

## Delivery

Each step is its own pull request, behind the switch.

1. Manifest: `capabilities.spot` and the optional `game_announce` hook, with the contract test.
2. Session volume for cold launched hosts, still on demand: create, attach, restore, archive, delete; sweeper and alarm.
3. Spot request with the on-demand fallback, and the market on the host record.
4. Host watcher: announce and save on the notice.
5. Control plane: the moving state, re-placement in the same zone, the snapshot or S3 fallback, notifications.
6. Panel: the host's market and the moving state, with the existing primitives.
7. Fault injection with AWS FIS on a test world; times recorded in `docs/measurements.md`.
8. Switch on for one cold world, then the rest.

## Alternatives considered

| Option | Why not chosen |
| --- | --- |
| Upload every world to S3 on the notice | The deadline is two minutes for all worlds on the host. A large world or a full host may not make it |
| `maintain` fleet with stop-on-interruption, as ADR-0027 chose | EC2 restarts the instance when capacity returns, which needs the fleet deleted at every stop, and the restart races the idle watchdog. The session volume gives the same recovery with a fresh instance |
| A volume that outlives sessions, one per world | Pins every start of the world to one zone and bills the volume all month |
| Spot with no on-demand fallback | Follows AWS guidance; a capacity shortfall means no server that evening |
| Stay on demand | Costs about twice as much for the same host |

## Open questions

- How long the save, the launch and the volume attach take for each game. Step 7 answers it.
- Whether a rebalance recommendation should warn players in chat. ADR-0027's answer was probably only a save; keep it
  until the step 7 numbers say otherwise.
- The volume type and size per game footprint.

## Sources

Read 2026-11-26.

- Spot best practices: <https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/spot-best-practices.html>
- Spot interruption notices: <https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/spot-instance-termination-notices.html>
- EC2 Fleet request types: <https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-fleet-request-type.html>
- Prices and placement scores: `aws ec2 describe-spot-price-history` and `aws ec2 get-spot-placement-scores`, read-only.
