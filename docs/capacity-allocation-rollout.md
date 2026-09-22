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
- Every port a placed session binds comes from its slot: the game's own ports on slot zero, the slot's window in the
  host-wide range otherwise. No other allocator exists, and no two slots on a host share a port whatever games they run.
- A session with no slot runs exactly as it did before placement existed: the same files, the default project, no
  memory limit. Cutover is the moment the workflows start passing a slot, and nothing before it.

## Atomic rollout phases

| Phase | Change | Production behaviour if work stops there |
| --- | --- | --- |
| 1 — domain model | `lambdas/src/domain/placement.ts`: footprints, shapes, best-fit placement, reservation with slot, drain decision, `warm` kept host; `lambdas/test/placement.test.ts` | Nothing imports it. **Landed with the ADR** |
| 2 — the question answered on paper | `lambdas/prototype/placement-evening.ts` replays evenings under three policies; the verdict goes to [docs/costs.md](costs.md) and the prototype is deleted | Nothing changes. **Landed with the ADR** |
| 3 — footprints as data | Per-game default footprint and per-world override in both catalogs (`gameFootprints` and `footprintForWorld` in the panel's; `footprint` per world and `GAME_FOOTPRINT_*` per module on the host, with a drift test between them); the allowed instance families as a filter; `npm run launch-requirements -- --verify` asks EC2 whether every footprint has an answer. Prices appear nowhere but `docs/costs.md` | Data nobody reads yet. **Landed** |
| 4 — host-side slot contract | A placed session (`SPAWNPOINT_SLOT`) is a Compose project named for its world, publishes its slot's ports (the game's own on slot zero, a window in the host-wide range otherwise), runs under its footprint's `mem_limit`, and leaves the observability tier out (phase 9 gives the host one); `check-host-activity.sh` counts neighbours across projects. A session with no slot is byte-identical to today. Project Zomboid refuses a slot other than zero until its ini carries the slot's ports | Every deployed workflow starts sessions with no slot. Nothing observable changes. **Landed** |
| 5 — host records | The placement side of the coordinator: one record per host under a `host#` key in the lifecycle table, `registerHost`, `placeSession`, `reserveOnHost`, `releasePlacement`, `decideDrain`, `concludeDrain`, each a conditional write. The start workflow describes the instance it ran on, registers it with its shape and reserves slot zero for the session; the stop releases the reservation. Every one of those steps fails open into the step the workflow was going to anyway, because nothing reads the records yet | A second kind of item in the table, two IAM statements, and a start or stop that behaves as before when the bookkeeping fails. **Landed** |
| 6 — placement in start | The start carries a `placement` mode from the API's `SPAWNPOINT_PLACEMENT` (`single` by default). Under `shared`, `Begin Session` is followed by registering the configured instance with its shape and asking the coordinator to place the session; a reuse answer names the host and the slot, which every host command carries from then on — the V1 start, the watchdog's probe, the stop, the compensation; a launch answer cancels the session cleanly, because launching is phase 12. The stop finds its session's placement itself, so the world lifecycle's stops and the watchdog's need no change. The V1 machines and the watchdog run the command they always ran when given no slot, so executions begun before this deploy finish as they began. Under `single` nothing changes but the phase-5 bookkeeping | `single`: as before. `shared`: two games on the one configured host, each in its own project and slot; a session nothing has room for is refused and cancelled, never started. **Landed** |
| 7 — two-level stop | A host record carries its provenance: `configured` is Terraform's instance, whose drain decision is always to stop and which the V1 stop already stops when idle; `launched` is a host created for a session. A stop that empties a launched host starts `spawnpoint-drain-host-v2` for it: wait the grace period, ask the coordinator, then move the record conditionally and only afterwards terminate or stop the machine; an empty host kept as headroom is asked again, a bounded number of times. Its IAM may stop or terminate only what carries `ManagedBy=spawnpoint-fleet`. The alarm on a drain that gave up is the `Spawnpoint.DrainKeptTooLong` failure, not yet a CloudWatch alarm | Nothing, until a host is launched: the configured host never enters the drain. **Landed** |
| 8 — the address with a port | The host already composes the session's address with its slot's port (phase 4); now the start carries that answer into the lifecycle record (`activeSessionAddress`, set by `markSessionReady`, cleared when the session stops), and the panel's read model shows the observed address for a ready session before the one it composes for a stopped world — still only to a caller allowed an address. A public world, whose security group opens the game's own port only, and a game that names its own ports to clients (Project Zomboid) are pinned to slot zero by the coordinator, so their address is the one they show today. No `SRV`: no Route 53 strategy exists on the host yet, and the overlay has no `SRV`, so every player sees `host:port` | Slot zero shows the port it shows today. The bot composes the configured world's address as before, which is right for the world it operates. **Landed** |
| 9 — observability per host | One tier per host, the Compose project `spawnpoint-observability` (`observability/compose.host.yaml` over `observability/compose.yaml`), brought up by the first placed session's start through `ensure-host-observability.sh` and left running while the host runs. Its Prometheus finds every session's exporter through the Docker socket by three `spawnpoint.scrape*` labels, over a network created outside both projects; a game takes part with `GAME_HOST_OBSERVABILITY_COMPOSE_FILE`. Every placed session, slot zero included, runs without a tier of its own; an unplaced session carries the tier inside its project, as before. The Minecraft dashboard gains a World variable and the host overview groups by project. A tier that will not come up is reported and the session starts unscraped | An unplaced session is unchanged. A placed session's Grafana is the host's, at the host's overlay address on port 3000. **Landed** |
| 10 — acceptance | On the owner's environment: Factorio beside the modded world on one host, tick time recorded for both alone and together, a stop of one leaving the other running, a restart inside the grace period reusing the host, a drain terminating a launched host after both leave. `scripts/acceptance-capacity-allocation.sh` drives each step and reads the figures from execution histories, host records and `server/scripts/measure-tick.sh`; `report` renders them. The harness asks for `shared` per start, so the deployed setting stays `single` while it runs | Failures are on a setting one revert restores. **Tooling landed; the run needs the owner's AWS** |
| 11 — cutover | Repository variables feed the access-api root: `SPAWNPOINT_PLACEMENT=shared` includes the configured host, while `fleet` excludes it and gives portable worlds scale-to-zero; `SPAWNPOINT_LAUNCH=enabled` only after the runbook's Parameter Store preflight passes; `SPAWNPOINT_FLEET_HEADROOM_MIB=0` keeps no idle host. Missing variables preserve the `single` / `disabled` / `0` defaults, and every deploy pins launched hosts to its tested commit | One variable reverts to `single` |
| 12 — launching a host | Behind `SPAWNPOINT_LAUNCH` (`disabled` by default): a start whose placement answers "launch" creates an instant EC2 Fleet from the `spawnpoint-fleet-host` template with the footprint's `InstanceRequirements`, the allowed families and `lowest-price`; records what EC2 answered as a `launched` host; reserves it; and terminates it at once if it cannot be recorded or reserved. The template names no instance type. The host bootstraps itself: the base user-data, then a checkout of this repository at the commit its `AppCommit` tag names, a `.env` rendered from Parameter Store under `/spawnpoint/host/env`, and an overlay join it authorises itself with the Central token under `/spawnpoint/host/zerotier-central-token`. A legacy world is bound to the configured host and is refused rather than launched for. Headroom is a Terraform setting on the drain (`headroom_mib`), zero by default; Spot per ADR-0027 and Fargate stay later | `disabled`: as before. `enabled`: **unverified against AWS** — the Fleet request, the bootstrap and the Central call were written from the API references and never run; phase 10 is where they are |

## Current phase

Phases 1 to 9 and 12 landed on 2026-09-17, all behind settings that default to what runs today, and the tooling of
phase 10 with them. What has never run against AWS, and must before `launch` is enabled: the `CreateFleet` request as
the start builds it, the fleet host's bootstrap end to end, the Central API authorisation, and the host tier's
discovery through the Docker socket on a real host. The phase-10 run itself needs the owner's environment; phase 11 is
one setting once its report is in.

Limits of the placement modes today, worth knowing before cutover:

- **A lifecycle record is one per game (`serverId`), with one active session.** Two worlds of different games share
  the host; two worlds of the same game still take turns, because the second `beginSession` on the game's record is
  a conflict. Keying the lifecycle by world is its own change, and not a small one.
- **The two legacy worlds live on the configured host's volume.** They are bound to it in the catalog and are never
  launched for; `fleet` refuses them explicitly. A world created from a preset lives in S3 between sessions and may
  land on a launched host. Migrating the legacy data is required before the configured instance can be removed.
- **A launched host is reached over the overlay it joins at boot**, which spends one of the overlay's ten device
  slots per host and needs the Central token in Parameter Store to authorise itself; without the token a person
  authorises it, and the start refuses until then. A world on a non-gating strategy needs `auth: external`, as
  ADR-0033 requires, before it may leave the overlay.

## What the acceptance run must record

- Milliseconds per tick for each of two co-tenant worlds with players on, against the same worlds alone. This is the
  number the ADR's core weight rests on.
- The start of a second session on a host that is already up, from request to `ready`.
- The drain: the minute the last session released, the minute the host terminated, and that nothing was billed after.
- The first `SRV` join and the first `host:port` join, one each, by a player who was not told which they were using.
  No `SRV` join exists until a Route 53 strategy does; the report says so and records `host:port` joins.

## How the run goes

Every command below appends to `acceptance/capacity-allocation/events.jsonl` and reads its figures from AWS, never from
the operator; `report` renders the file into the document that closes this phase. A Factorio world created from a
preset is the second tenant, because the two legacy worlds are bound to the configured host and share one Minecraft
lifecycle record.

```bash
scripts/acceptance-capacity-allocation.sh start --world world            # the modded world, alone
scripts/acceptance-capacity-allocation.sh tick  --world world            # with players on: the alone figure
scripts/acceptance-capacity-allocation.sh start --world <factorio-world> --game factorio # lands beside it: seconds to ready
scripts/acceptance-capacity-allocation.sh tick  --world world            # both with players on: the co-tenant figures
scripts/acceptance-capacity-allocation.sh tick  --world <factorio-world>
scripts/acceptance-capacity-allocation.sh join  --world <factorio-world> --kind host-port --player <name>
scripts/acceptance-capacity-allocation.sh stop  --world <factorio-world> # the modded world keeps running
scripts/acceptance-capacity-allocation.sh start --world <factorio-world> --game factorio # inside the grace period: the same host
scripts/acceptance-capacity-allocation.sh stop  --world <factorio-world>
scripts/acceptance-capacity-allocation.sh stop  --world world
scripts/acceptance-capacity-allocation.sh report --out docs/acceptance/capacity-allocation-$(date -u +%F).md
```

A drain needs a launched host, which needs `launch = "enabled"` and a world that is not bound to the configured host:
with the Parameter Store keys in place, `start --world <factorio-world> --launch enabled` while the configured host is
full (or stopped), with `--game factorio` for a world the host catalog does not list, launches one; `drain --host <its instance id>` after its stop waits for the record to move and reads
the grace and termination minutes from the drain execution. Factorio's tick reading runs a Lua command, which disables
achievements on that save; the harness says so with `SPAWNPOINT_ACCEPT_ACHIEVEMENT_LOSS=1` and the acceptance world
should be one nobody plays for achievements.
