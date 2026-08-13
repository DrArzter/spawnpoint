# Measurements

Nine blanks. Filling them turns most of the open questions in the ADRs from opinion into arithmetic.

All of them can be answered by running the intended pack locally with the `itzg` image and playing one evening with
the group. No AWS account, no Terraform, no spending. Do this before M0.

Record the date and the pack version beside each answer, because they all change when the pack does.

## The blanks

### 1. Pack, Minecraft version, loader version — **answered**

| | |
| --- | --- |
| Value | **Forge, Minecraft 1.20.1. 111 mods**, hand-assembled from CurseForge rather than a published pack |
| Source | The owner's working config: <https://github.com/DrArzter/my-docker-minecraft-server-config> |
| Unblocks | The release definition in [ADR-0008](adr/0008-versioned-mod-releases.md), the image tag in [ADR-0005](adr/0005-containerised-game-server.md) |

Heavy tech: Mekanism suite, Applied Energistics 2, Refined Storage, Immersive Engineering, Industrial Foregoing,
Powah, Create — plus Sinytra Connector running Fabric mods on Forge. Two consequences worth writing down:

- **Tick load will be high.** Those are the mods that make milliseconds-per-tick climb. It does not change the
  decision — see the accepted risk in [ADR-0032](adr/0032-on-demand-single-instance.md) — but it makes the
  measurement in item 2 more likely to matter rather than less.
- **ARM cannot be assumed.** Connector, mixins and Fabric-on-Forge raise the chance of an architecture-specific
  problem, so item 3 has to be an actual test rather than an inference.

### 2. Peak memory with the real group online — **partly answered**

| | |
| --- | --- |
| Allocated today | **4096M**, in the working config, which has been running fine |
| Highest observed, 2026-08-12 | With **one player running through and exploring the world**, `docker stats` reported **5.863 GiB / 62.6 GiB (9.37%)** for the Minecraft container, with **18.74% CPU** at the instant sampled |
| Earlier snapshot | **5.439 GiB (8.69%)**, with **2.80% CPU** |
| First AWS live session, 2026-08-13 | With **one player moving through the real world**, Prometheus recorded Minecraft peaks of **5,336,694,784 bytes (4.97 GiB)** and **59.94% of one CPU core**. Host memory use peaked at **78.46%** on the 8 GiB `m7i-flex.large`; Minecraft stayed healthy with zero restarts and no OOM kill |
| Larger-world comparison | Starting and playing in a substantially larger, developed world with many mechanisms and mobs produced no material change in the observed CPU load. This is a meaningful steady-state observation on the i9-14900KF, though it does not predict the single-core performance of the eventual EC2 type |
| Remaining context | Session age was not recorded. Exploration can generate and load chunks, so this is a meaningful one-player workload, but not a confirmed peak for the full group |
| How | Play with everybody on. Watch container memory, and the JVM heap the server reports |
| Unblocks | Instance size in [ADR-0032](adr/0032-on-demand-single-instance.md). This is the number that decides the hourly rate |

4 GB for 111 tech mods is already the lower end of the JVM heap bracket, and it works. The container snapshot confirms
that a 4 GiB EC2 instance is insufficient: total container-accounted memory reached 5.863 GiB, about **1.86 GiB above
the configured maximum Java heap**. The starting instance therefore needs at least 8 GiB. That leaves only about
2.14 GiB before the physical 8 GiB ceiling for load growth, the operating system, Docker and the overlay agent. Since
this was already reached with one exploring player, **16 GiB is the safer starting point for the first AWS run**. A
full-group measurement decides whether downsizing to 8 GiB is safe rather than making 8 GiB the optimistic starting
assumption.

Record the peak, not the average, and note how many players produced it. Watch CPU as well: the useful figure is how
many cores' worth the server actually uses under load.

Docker's CPU percentage is measured in CPU equivalents and may exceed 100% on a multicore host; 18.74% is roughly
0.19 of one logical CPU at that instant, not 18.74% of the entire i9-14900KF. It also misses short tick spikes. Use
milliseconds per tick under load for game-server sizing rather than this snapshot alone.

Capture the unambiguous numerator and denominator together:

```bash
docker stats --no-stream --format 'table {{.Name}}\t{{.MemUsage}}\t{{.MemPerc}}\t{{.CPUPerc}}'
```

For the JVM view, use RCON or Java tooling to record used heap alongside the container figure. Container memory and
heap answer different questions; EC2 sizing follows the former.

**The bracket is already known from experience** — 2 cores and 4 GB is often enough, 4 cores and 16 GB runs anything
comfortably. So this measurement is not open-ended; it decides *where in that range* this pack sits.

**And it decides real money.** Each step up the range roughly doubles the compute line, and on a rented dedicated box it
is the difference between about €7.50, €14 and €28 a month. See [docs/costs.md](costs.md).

### 3. Does the pack run on ARM

| | |
| --- | --- |
| Value | **Not measuring. x86 chosen** — see below |
| Unblocks | Closed by decision rather than by measurement |

**Dropped, and the reason is that the prize is too small.** Graviton is perhaps 15–20% cheaper per hour, which on a
compute line of about $3.40 is **under a dollar a month**. Against that: Graviton is slower per core, and
[ADR-0032](adr/0032-on-demand-single-instance.md) already establishes that single-thread performance matters more
here than the hourly rate, because the main tick cannot be spread across cores. And with Sinytra Connector bridging
Fabric mods on Forge, an architecture problem would most likely surface as a subtle failure under load rather than a
clean refusal to start — which is the worst way to find out, at ten o'clock on a live server.

**So: x86.** It is faster where it matters, it has the larger instance-type pool for the fleet in
[ADR-0027](adr/0027-spot-request-shape.md), and it removes a decision. Revisit only if the compute line ever becomes
large enough for 20% of it to matter.

### 4. World and mod-set size — **answered for the current save**

| | |
| --- | --- |
| World, 2026-08-12 | **597.7 MiB (626,724,748 bytes), 579 files in 161 directories** |
| Mod set, 2026-08-12 | **594 MiB** |
| First real backup, 2026-08-12 | **417,306,157 bytes (~398 MiB)** as `tar.zst`, SHA-256 verified; approximately **66.6%** of the source size. Forge stored the dimensions under one top-level world directory |
| First local restore drill, 2026-08-12 | Restored into `/tmp/spawnpoint-restore-test`; apparent restored size was **635,598,718 bytes**. `diff -qr` against the stopped source world returned no differences. `du` showed 608M source versus 607M restored because allocated filesystem blocks can differ after extraction; file contents matched. The copy then booted successfully with the matching 111-mod set in an isolated container, reached Docker `healthy`, answered over RCON and exited cleanly after saving every dimension |
| First post-session AWS archive, 2026-08-13 | After confirming 0 players and completing `save-all flush`, all session containers stopped cleanly. The archive was **418,783,052 bytes**, contained **777 entries** including `world/level.dat`, and passed SHA-256 plus full-stream verification. It currently lives on the same persistent EBS and is therefore a verified recovery artifact, not yet an off-volume backup |
| How | `du -sh` on the world directory |
| Unblocks | Volume size, and it already settled the backup question |

This is a comparatively developed world, and it can still grow substantially as more chunks and modded dimensions are
explored. Record the figure again after a representative month rather than treating 598 MiB as a ceiling.

Two conclusions already follow from the measurement:

- **The world is not the cost driver.** [ADR-0026](adr/0026-tiered-backups.md) proposed incremental snapshots to avoid
  seventeen full archives dominating the bill; at this size each copy is about 0.6 GiB and it was rejected.
  Full archives after every session, per [ADR-0010](adr/0010-world-persistence-and-backups.md), are correct and simpler.
- **The volume can be much smaller than the 50 GB placeholder.** Since the volume was the largest fixed line in
  [docs/costs.md](costs.md), this is a real reduction rather than a rounding difference. Size it for the mod releases and
  several worlds, not for the save data.

Nine retained full archives occupy about **5.3 GiB before compression**, still a small storage line. The 20 GB EBS
starting size remains plausible for one world and its working mod set, but free-space monitoring is required before
adding several worlds or retaining release binaries locally.

### 5. Cold start: how long from container start to joinable — **AWS container path answered**

**Now the highest-frequency number in the system**, because the expected pattern is 2–3 hours most nights, so this is
paid every single evening rather than a few times a week.

| | |
| --- | --- |
| End-to-end local observation, 2026-08-12 | **Approximately 1 minute 30 seconds**, including loading the full mod set |
| Minecraft/Forge internal load time, 2026-08-12 | **38.264 seconds** on a restart, reported by ModernFix as `Dedicated server took 38.264 seconds to load` |
| Restored-copy smoke test, 2026-08-12 | **17.564 seconds** of Minecraft/Forge internal load time; Docker reported `healthy`, RCON answered, idle memory was **4.734 GiB**, and the container shut down with exit code 0 after saving all dimensions |
| First AWS boot, `m7i-flex.large`, 2026-08-13 | **127 seconds** from `docker compose up` to Docker `healthy`; ModernFix reported **70.513 seconds** for the Minecraft/Forge load. RCON answered, the real world and all 111 JARs loaded, and the process was not OOM-killed |
| First AWS memory snapshot | Minecraft used **4.898 GiB / 7.601 GiB (64.44%)** with no players. The 8 GiB host had **2.4 GiB available** and no swap immediately after startup |
| Hardware | **Intel Core i9-14900KF**; this is a strong desktop CPU and therefore a lower bound, not an EC2 forecast |
| How | Time it. Locally it is a lower bound; EC2 adds instance boot and a mod sync on top |
| Unblocks | The whole premise of [ADR-0006](adr/0006-on-demand-start-and-idle-shutdown.md), which assumes 1–3 minutes is tolerable |

The two values measure different boundaries. ModernFix's 38.264 seconds covers the application loading Forge and the
mods after the JVM is already running. The roughly 90-second observation includes more of the local container path.
Neither local value includes Spot capacity, EC2 boot or release reconciliation. The first AWS value closes only the
container-to-healthy segment on an on-demand smoke host; it does not yet measure request-to-ready or Spot capacity.
The result supports the on-demand premise, but Step Functions must measure the full boundary: request accepted,
capacity acquired, operating system and SSM ready, release reconciled, server healthy and a player able to join.

The first restored-copy boot also exposed a useful failure mode. The copied environment had
`REMOVE_OLD_MODS=true`, but the disposable container did not receive `CURSEFORGE_FILES`; image initialisation therefore
removed all 111 copied JARs and Forge could not decode the world's modded dimensions. Restoring the exact mod set and
setting `REMOVE_OLD_MODS=false` made the same world boot successfully. A world archive is necessary but not sufficient:
restore must select an exact immutable release before starting Minecraft.

### 5a. Session observability — **locally exercised**

The first Compose smoke test on 2026-08-12 started Prometheus 3.5.3, Grafana 13.1.0, `mc-monitor`, node_exporter
and cAdvisor alongside an isolated restored copy of the real world. All four Prometheus targets were up, Grafana
provisioned the eight-panel `Session overview` dashboard from the repository, Minecraft reported `healthy=1`, and
RCON answered. Stopping the Compose project stopped the dashboard and collectors as well as Minecraft.

cAdvisor 0.53 could not discover containers on the local Docker 29 `overlayfs` image store. Version 0.60.5 did, so
that compatibility is now pinned rather than assumed. A second trap appeared after recreating `mc`: Prometheus keeps
the removed container's last series briefly, and a plain `sum` double-counted old and new memory. Dashboard container
queries therefore join against `container_last_seen < 30 seconds` before aggregating.

The first AWS session on 2026-08-13 then exercised the same pinned stack on the real M0 host. Prometheus, Grafana,
`mc-monitor`, cAdvisor and node_exporter started without recreating the already healthy Minecraft container. Grafana
was reachable on the host's private ZeroTier address; Prometheus remained loopback-only. The first screenshot exposed
that the disk panel watched the 8 GiB root volume rather than the persistent game-data EBS, so its query was corrected
from mountpoint `/` to `/srv/spawnpoint` and verified through the Grafana API.

During the first one-player AWS session, the maximum status response time was **30.98 ms**, Minecraft CPU reached
**59.94% of one core**, and the persistent EBS never fell below **19,636,432,896 bytes (18.29 GiB) available**. These
are Prometheus maxima/minima over the observed session rather than hand-picked `docker stats` snapshots.

The session ended with a complete lifecycle acceptance test: RCON confirmed zero players, the server flushed and
stopped, all observability containers stopped with it, the world archive verified, and EC2 reached `stopped` with no
public address. The persistent 20 GiB EBS remained encrypted, attached and `DeleteOnTermination=false`.

### 6. LAN discovery on a clean client, over the overlay

| | |
| --- | --- |
| Value | |
| How | On a client with an **empty server list**, connected via the overlay: does the server appear under the local-network scan with nothing added by hand? |
| Unblocks | The open question in [ADR-0024](adr/0024-connectivity-modes.md) |

If yes: find which mod does it — the `itzg` image contains no LAN discovery code — and make it a required entry in
every release. If no: the earlier observation was a server-list entry, and a broadcaster has to be added deliberately.

### 7. Head count and device count for the real group

| | |
| --- | --- |
| People | ~6, and confirmed to fit |
| Devices they will actually connect from | **Within ZeroTier's 10**, confirmed 2026-08-12 |
| Unblocks | Now a yes/no rather than a choice. **ZeroTier is chosen** in [ADR-0024](adr/0024-connectivity-modes.md), so the only question is whether the group fits its free tier: **10 devices, 1 network**. Count second machines |

Count devices honestly, including anybody's second machine. This is the number that decides which free tier fits.

### 8. Latency from each player to each candidate region

### 8. Region — **settled: `eu-central-1` (Frankfurt)**

Players are in **Poland, Ukraine and western Russia**, confirmed 2026-08-12. That eliminates London immediately, and it
makes Frankfurt the closest major region to all three.

**Stockholm is no longer worth comparing, and the reason is that Spot was deferred.** The case for eu-north-1 was that
it is often the cheapest European region and might have better Spot capacity. With on-demand
([ADR-0027](adr/0027-spot-request-shape.md)), capacity is not a variable, and the on-demand price difference is on the
order of a dollar a month against a latency penalty for the eastern end of the group. Not a trade worth measuring.

The latency test below is therefore **not needed to choose**. Whether Frankfurt is good enough is answered by playing on
it, which M0 does anyway. Left here in case it ever needs revisiting.

| Region | Best | Worst |
| --- | --- | --- |
| `eu-central-1` (Frankfurt) | | |
| `eu-north-1` (Stockholm) | | |
| ~~`eu-west-2` (London)~~ | dropped | dropped |

| | |
| --- | --- |
| How | Each player runs a regional latency check — a public AWS latency test site will do — and reports their figure |
| Unblocks | The region choice in [ADR-0002](adr/0002-host-on-aws.md) |

The config sets `TZ: Europe/Warsaw`, and the VPS plans priced above are Warsaw ones, so assume a Central European
player base. That reorders the candidates: Frankfurt first, then Stockholm, with London a distant third. AWS has no
Warsaw region, so Frankfurt is the closest.

Optimise for the **worst** player, not the average. One person on 200 ms ruins the evening for everybody. Stockholm is
often the cheapest European region, so if the numbers are close, price decides.

Still worth measuring rather than assuming, because routing from that part of Europe varies a great deal by provider —
Frankfurt is the larger hub with more peering eastward, Stockholm is physically closer to the north-eastern end of the
group. Expect both to land in a similar range and London to be clearly worse; confirm rather than trust that.

### 9. Spot price and capacity for the candidate types, per region

**Collected 2026-08-12, `eu-central-1`.** On-demand Linux, current generation, x86_64, 2 vCPU / 16 GiB:

| Type | On-demand $/h | Note |
| --- | --- | --- |
| `r5a.large` | 0.137 | Cheapest comparable. AMD, older generation, slower per thread |
| `r5ad.large` | 0.158 | `d` = local NVMe, wiped on stop — not useful here |
| **`r8i.large`** | **0.16758** | **Chosen.** Newest Intel generation, best single thread |
| `r5d.large` | 0.173 | |
| `r5b.large` | 0.178 | |
| `r7a.large` | 0.18354 | |
| `r8a.large` | 0.19272 | |

The whole current-generation spread is about $4 a month, which is why the criterion is the fastest thread rather than
the cheapest hour. See [ADR-0032](adr/0032-on-demand-single-instance.md).

**Spot price, interruption band and placement score are not collected**, because
[ADR-0027](adr/0027-spot-request-shape.md) is deferred. They become relevant again only if Spot is adopted.

| | |
| --- | --- |
| Unblocks | The region in [ADR-0002](adr/0002-host-on-aws.md) — **together with latency above** — and the instance-type list in [ADR-0027](adr/0027-spot-request-shape.md) |

This decides the region jointly with latency, and it decides whether the cost model survives: the Spot discount is
load-bearing, not an optimisation. See [docs/costs.md](costs.md).

### Before measuring anything: three one-time things

Do these first. They take five minutes and two of them cannot be done retroactively.

1. **MFA on the root account**, then stop using root. Create a normal administrative identity for daily work. Root with
   no MFA is the single largest cost exposure in [docs/costs.md](costs.md), because it is the route to the
   four-figure stories.
2. **A Budgets alarm**, before any long-running resource exists. Set it well above the ~$7 model — $20 is a sensible
   line that means "something is wrong" rather than "we played a lot".
3. **Confirm which plan the account is on.** Free is correct for M0, which is throwaway; move to Paid before M1, when
   the real world arrives. See [docs/costs.md](costs.md).

### Which instance types to price

Settled: **x86, memory-optimised, 16 GiB.** Cores are not the constraint — 0.19 of one was in use at the sampled
instant — so a `.large` with 16 GiB is the shape, not an `.xlarge` with four vCPUs. Start with:

`r7i.large`, `r7a.large`, `r6i.large`, `r6a.large`, `r5.large`, `r5a.large`

The fleet in [ADR-0027](adr/0027-spot-request-shape.md) wants around ten types, so older generations are useful rather
than embarrassing: they are less in demand, which is exactly what makes their Spot capacity better.

**Gotcha worth checking first:** newer families are not present in every region. Stockholm carries fewer instance
families than Frankfurt, so confirm the `r7` generations exist in `eu-north-1` before pricing them — if they do not,
that alone may decide the region.

### In the console

| What | Where |
| --- | --- |
| Spot price history | EC2 → **Spot Requests** → *Pricing history*. Pick the type, Linux/UNIX, and read the per-AZ graph |
| Spot placement score | EC2 → **Spot Requests** → *Spot placement score*. Ask for 1 instance with the requirements above, across both regions |
| Interruption frequency | Not in the console. The **Spot Instance Advisor** is a separate public page |

### Or from the command line

Faster, and it fills this table directly. Credentials were not configured on this machine as of 2026-08-12.

```bash
aws ec2 describe-spot-price-history --region eu-central-1 --instance-types r7i.large r7a.large r6i.large r5.large --product-descriptions Linux/UNIX --start-time "$(date -u -v-7d +%Y-%m-%dT%H:%M:%S)" --query 'SpotPriceHistory[].[InstanceType,AvailabilityZone,SpotPrice]' --output table
```

Repeat with `--region eu-north-1`. Then ask AWS where the capacity actually is:

```bash
aws ec2 get-spot-placement-scores --region eu-central-1 --target-capacity 1 --target-capacity-unit-type units --single-availability-zone --instance-requirements-with-metadata '{"ArchitectureTypes":["x86_64"],"VirtualizationTypes":["hvm"],"InstanceRequirements":{"VCpuCount":{"Min":2,"Max":4},"MemoryMiB":{"Min":15000}}}' --region-names eu-central-1 eu-north-1
```

A placement score runs 1 to 10 and is a point-in-time reading, not a guarantee.

## One decision that is already made

`online-mode=false` is **not** an open question for the first world. That world already exists and has been played, so
its player data is keyed by offline UUIDs; switching to online mode would orphan everybody's inventories and positions.
The one-way door has already been walked through, and the only way to run a world in online mode is to start a new one.

Worth knowing rather than deciding, because it means the network gate in
[ADR-0024](adr/0024-connectivity-modes.md) is mandatory rather than advisable. See
[ADR-0022](adr/0022-minecraft-account-as-linked-identity.md).

## What is left, and it is not measurement

Nothing above still blocks M0. What remains in the AWS console is **setup**, not research:

1. **MFA on root, then stop using it.** Create a normal administrative identity — the sequence, including the billing
   toggle that only root can flip, is in [the runbook](runbook.md#account-bootstrap).
2. **A Budgets alarm at about $20.** Above the ~$15.55 model, well below a surprise. This matters more since
   [ADR-0027](adr/0027-spot-request-shape.md) was deferred: a failed stop now costs ~$129 a month rather than ~$40.
3. **Pick one Availability Zone in `eu-central-1` and write it down.** The data volume is zonal, so this choice binds
   every later launch. See [ADR-0032](adr/0032-on-demand-single-instance.md).
4. **Confirm the account is on the Free plan** — correct for the throwaway M0. Move to Paid before M1. See
   [docs/costs.md](costs.md).

Then M0 is building rather than deciding.

## Then what

With these filled in, M0 is no longer a guess: the instance size, the volume size, the region and the connectivity
mode all follow from the numbers. Update [docs/costs.md](costs.md) with the real figures at the same time, replacing
the placeholders.
