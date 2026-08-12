# Measurements

Nine blanks. Filling them turns most of the open questions in the ADRs from opinion into arithmetic.

All of them can be answered by running the intended pack locally with the `itzg` image and playing one evening with
the group. No AWS account, no Terraform, no spending. Do this before M0.

Record the date and the pack version beside each answer, because they all change when the pack does.

## The blanks

### 1. Pack, Minecraft version, loader version

| | |
| --- | --- |
| Value | |
| How | Choose the first pack — vanilla-plus is the sensible one to start with |
| Unblocks | The release definition in [ADR-0008](adr/0008-versioned-mod-releases.md), the image tag in [ADR-0005](adr/0005-containerised-game-server.md) |

### 2. Peak memory with the real group online

| | |
| --- | --- |
| Value | |
| How | Play with everybody on. Watch container memory, and the JVM heap the server reports |
| Unblocks | Instance size in [ADR-0004](adr/0004-ec2-spot-for-the-game-server.md). This is the number that decides the hourly rate |

Record the peak, not the average, and note how many players produced it. Watch CPU as well: the useful figure is how
many cores' worth the server actually uses under load.

**The bracket is already known from experience** — 2 cores and 4 GB is often enough, 4 cores and 16 GB runs anything
comfortably. So this measurement is not open-ended; it decides *where in that range* this pack sits.

**And it decides real money.** Each step up the range roughly doubles the compute line, and on a rented dedicated box it
is the difference between about €7.50, €14 and €28 a month. See [docs/costs.md](costs.md).

### 3. Does the pack run on ARM

| | |
| --- | --- |
| Value | |
| How | **Already answered by running it on an Apple Silicon Mac.** If it runs there, it runs on Graviton |
| Unblocks | The open ARM question in [ADR-0004](adr/0004-ec2-spot-for-the-game-server.md), worth roughly 20% of the compute bill |

A free answer to a real question, purely because the laptop is the same architecture.

### 4. World size — approximately known, worth confirming

| | |
| --- | --- |
| Estimate | **~200–300 MB** for the existing world |
| Confirmed value | |
| How | `du -sh` on the world directory |
| Unblocks | Volume size, and it already settled the backup question |

Two conclusions already follow from the estimate:

- **The world is not the cost driver.** [ADR-0026](adr/0026-tiered-backups.md) proposed incremental snapshots to avoid
  seventeen full archives dominating the bill; at this size those copies are under half a gigabyte and it was rejected.
  Full archives after every session, per [ADR-0010](adr/0010-world-persistence-and-backups.md), are correct and simpler.
- **The volume can be much smaller than the 50 GB placeholder.** Since the volume was the largest fixed line in
  [docs/costs.md](costs.md), this is a real reduction rather than a rounding difference. Size it for the mod releases and
  several worlds, not for the save data.

Confirm the number anyway, because the whole revised cost model now rests on it.

### 5. Cold start: how long from container start to joinable

**Now the highest-frequency number in the system**, because the expected pattern is 2–3 hours most nights, so this is
paid every single evening rather than a few times a week.

| | |
| --- | --- |
| Value | |
| How | Time it. Locally it is a lower bound; EC2 adds instance boot and a mod sync on top |
| Unblocks | The whole premise of [ADR-0006](adr/0006-on-demand-start-and-idle-shutdown.md), which assumes 1–3 minutes is tolerable |

If a big pack takes six minutes locally, the on-demand model needs rethinking before it is built, not after.

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
| People | |
| Devices they will actually connect from | |
| Unblocks | The overlay vendor in [ADR-0024](adr/0024-connectivity-modes.md): ZeroTier's free tier limits devices, Tailscale's limits people |

Count devices honestly, including anybody's second machine. This is the number that decides which free tier fits.

### 8. Latency from each player to each candidate region

| Region | Best | Worst |
| --- | --- | --- |
| `eu-west-2` (London) | | |
| `eu-central-1` (Frankfurt) | | |
| `eu-north-1` (Stockholm) | | |

| | |
| --- | --- |
| How | Each player runs a regional latency check — a public AWS latency test site will do — and reports their figure |
| Unblocks | The region choice in [ADR-0002](adr/0002-host-on-aws.md) |

Optimise for the **worst** player, not the average. One person on 200 ms ruins the evening for everybody. Stockholm is
often the cheapest European region, so if the numbers are close, price decides.

### 9. Spot price and capacity for the candidate types, per region

| Region | Spot $/h | On-demand $/h | Interruption band | Placement score |
| --- | --- | --- | --- | --- |
| `eu-west-2` (London) | | | | |
| `eu-central-1` (Frankfurt) | | | | |
| `eu-north-1` (Stockholm) | | | | |

| | |
| --- | --- |
| Unblocks | The region in [ADR-0002](adr/0002-host-on-aws.md) — **together with latency above** — and the instance-type list in [ADR-0027](adr/0027-spot-request-shape.md) |

This decides the region jointly with latency, and it decides whether the cost model survives: the Spot discount is
load-bearing, not an optimisation. See [docs/costs.md](costs.md).

Real prices come from the API, not from the pricing page, which renders in a browser. With credentials configured:

```bash
aws ec2 describe-spot-price-history --region eu-north-1 --instance-types m7g.xlarge --product-descriptions Linux/UNIX --start-time "$(date -u -v-7d +%Y-%m-%dT%H:%M:%S)" --query 'SpotPriceHistory[].[AvailabilityZone,SpotPrice,Timestamp]' --output table
```

Repeat per region and per candidate type. Then ask AWS where the capacity actually is:

```bash
aws ec2 get-spot-placement-scores --region eu-north-1 --target-capacity 1 --target-capacity-unit-type units --single-availability-zone --instance-requirements-with-metadata '{"ArchitectureTypes":["arm64"],"VirtualizationTypes":["hvm"],"InstanceRequirements":{"VCpuCount":{"Min":2,"Max":8},"MemoryMiB":{"Min":15000}}}' --region-names eu-west-2 eu-central-1 eu-north-1
```

A placement score runs 1 to 10 and is a point-in-time reading, not a guarantee. Interruption bands — under 5%, 5–10%, and
so on — come from the Spot Instance Advisor in the console, which has no public API.

Note that credentials are **not** configured on this machine yet, so none of this has been run.

## One decision that is already made

`online-mode=false` is **not** an open question for the first world. That world already exists and has been played, so
its player data is keyed by offline UUIDs; switching to online mode would orphan everybody's inventories and positions.
The one-way door has already been walked through, and the only way to run a world in online mode is to start a new one.

Worth knowing rather than deciding, because it means the network gate in
[ADR-0024](adr/0024-connectivity-modes.md) is mandatory rather than advisable. See
[ADR-0022](adr/0022-minecraft-account-as-linked-identity.md).

## Then what

With these filled in, M0 is no longer a guess: the instance size, the volume size, the region and the connectivity
mode all follow from the numbers. Update [docs/costs.md](costs.md) with the real figures at the same time, replacing
the placeholders.
