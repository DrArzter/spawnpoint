# Capacity allocation rollout

How [ADR-0054](adr/0054-place-a-session-on-a-host-with-room.md) reaches production without a cutover that can strand a
world. The pattern is the one [Lifecycle V2](lifecycle-v2-rollout.md) used: the domain model first, pure and tested;
data and storage next, inert; the host-side contract before any workflow depends on it; the workflow change last, behind
a default that still says "one host per world" until the acceptance run says otherwise.

## State ownership

| Fact | Owner | Not the owner |
| --- | --- | --- |
| Which host a session runs on, and in which slot | The host record's reservations, one item per host in the lifecycle table | The EC2 tag, the Compose project name, the panel |
| How much a world needs | The catalog's footprint, per world, defaulting per game | The Compose file's `MEMORY` (derived from it), the host |
| Which instance a launch becomes | EC2, from the footprint's requirements, by price at launch time | The catalog, the code, a person reading a price table |
| Which instance families may be launched at all | The allowed-families filter in the catalog, a filter and not a ranking | Code |
| Whether a host may go | The drain decision over the record: empty, past the grace period, still empty on re-read | The idle watchdog (it stops sessions, not hosts), the host-idle sensor (evidence, not authority) |
| Whether a host may be terminated rather than stopped | The verified archive of every session that left it, then the kept-world rule | Anything that did not verify an upload |

## Required invariants

- Sum of memory footprints on a host ≤ shape memory − system reserve; sum of core weights ≤ vCPU − half a core.
  Enforced in `reserve()`, and the store applies it with a conditional write on the record's version.
- A session's reservation is released only after its stop reports a verified upload. A stop that cannot is a stuck
  session on a host that cannot drain, which the alarm names.
- A host is terminated or stopped only through the drain decision, re-read and applied conditionally. Nothing else
  calls `TerminateInstances` on a host with a reservation.
- A launch asks for the footprint beside the system reserve and nothing more. No instance type and no price appears in
  the control plane or the catalog. One world on one evening costs what it costs under ADR-0048.
- Headroom is zero unless a deployment sets it, and nothing is kept when nothing runs.
- Every port a session binds comes from its slot: the game's own ports on slot zero, the slot's window in the
  host-wide range otherwise. No other allocator exists, and no two slots on a host share a port whatever games they run.

## Atomic rollout phases

| Phase | Change | Production behaviour if work stops there |
| --- | --- | --- |
| 1 — domain model | `lambdas/src/domain/placement.ts`: footprints, shapes, best-fit placement, reservation with slot, drain decision, `warm` kept host; `lambdas/test/placement.test.ts` | Nothing imports it. **Landed with the ADR** |
| 2 — the question answered on paper | `lambdas/prototype/placement-evening.ts` replays evenings under three policies; the verdict goes to [docs/costs.md](costs.md) and the prototype is deleted | Nothing changes. **Landed with the ADR** |
| 3 — footprints as data | Per-game default footprint and per-world override in both catalogs (`gameFootprints` and `footprintForWorld` in the panel's; `footprint` per world and `GAME_FOOTPRINT_*` per module on the host, with a drift test between them); the allowed instance families as a filter; `npm run launch-requirements -- --verify` asks EC2 whether every footprint has an answer. Prices appear nowhere but `docs/costs.md` | Data nobody reads yet. **Landed** |
| 4 — host-side slot contract | Each session is a Compose project named for the world; the adapter reads `SPAWNPOINT_SLOT` and binds the game's own ports on slot zero and its slot's window in the host-wide range otherwise; `check-host-activity.sh` counts projects; `MEMORY` and the cgroup limit are derived from the footprint. Slot zero is byte-identical to today | Every deployed workflow uses slot zero and one project. Nothing observable changes |
| 5 — host records | The placement item in the lifecycle table, written for the one host that exists today at slot zero, by the start and stop workflows as they run. Read by nobody | A second table item; a saved add-only plan |
| 6 — placement in start | A `Place Session` step between `Begin Session` and `Start Accepted V1`: read hosts, place, reserve conditionally; on a launch, an EC2 Fleet of type `instant` with the footprint's `InstanceRequirements` and `lowest-price`, the answered instance recorded as the host's shape, then wait for it to answer SSM. Behind a `placement: single \| shared` setting defaulting to `single`, under which it always launches | Identical to today except that EC2, not a variable, names the instance type — and one extra record written |
| 7 — two-level stop | The stop workflow ends with a session-level stop (`keepHost`) plus a release; a new drain machine, started by the release that empties a host, waits the grace period, re-reads and decides; the running-hours alarm covers any tagged host, and a new alarm covers a drain that outlived its period | With `single`, every release empties its host, so every stop is followed by a drain that terminates. Same bill as ADR-0048 plus the grace period |
| 8 — the address with a port | The strategy of ADR-0033 receives the slot's port; the Route 53 strategy publishes `SRV` for Minecraft; the panel, the bot and `/address` show `host:port` where a name cannot carry it | Slot zero shows the port it shows today |
| 9 — observability per host | One Prometheus and Grafana per host, scraping every session's exporter by Compose label; dashboards keyed by session | The single-session dashboard keeps working on a one-session host |
| 10 — acceptance | `placement: shared` on the owner's environment: Factorio beside the modded world on one host, tick time recorded for both, a stop of one leaving the other running, a restart inside the grace period reusing the host, a drain terminating a host after both leave | Failures are on a setting one revert restores |
| 11 — cutover | Default `placement: shared`, `fit` policy | One setting reverts to `single` |
| 12 — later, separately | Headroom as a deployment setting; Spot per ADR-0027 as the same launch request with a Spot target capacity; Fargate for a world that has left the overlay | Not part of this rollout |

## Current phase

Phases 1 to 3 landed on 2026-09-17. Phase 4, the host-side slot contract, is next; slot zero stays byte-identical.

## What the acceptance run must record

- Milliseconds per tick for each of two co-tenant worlds with players on, against the same worlds alone. This is the
  number the ADR's core weight rests on.
- The start of a second session on a host that is already up, from request to `ready`.
- The drain: the minute the last session released, the minute the host terminated, and that nothing was billed after.
- The first `SRV` join and the first `host:port` join, one each, by a player who was not told which they were using.
