# Measurements

Eight blanks. Filling them turns most of the open questions in the ADRs from opinion into arithmetic.

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

Record the peak, not the average, and note how many players produced it.

### 3. Does the pack run on ARM

| | |
| --- | --- |
| Value | |
| How | **Already answered by running it on an Apple Silicon Mac.** If it runs there, it runs on Graviton |
| Unblocks | The open ARM question in [ADR-0004](adr/0004-ec2-spot-for-the-game-server.md), worth roughly 20% of the compute bill |

A free answer to a real question, purely because the laptop is the same architecture.

### 4. World size, and how much an evening changes

| | |
| --- | --- |
| Size now | |
| Size after one evening | |
| Compressed size | |
| How | `du -sh` on the existing world directory — **this one is answerable right now.** Then again after a session, and once compressed |
| Unblocks | Volume size, the dominant fixed cost in [docs/costs.md](costs.md), and the backup tiering in [ADR-0026](adr/0026-tiered-backups.md) |

The world already exists and is large, which makes this the highest-value single number in this document.

Three things follow from it:

- **Volume size**, with headroom for mods, logs and the other worlds that M6 will add.
- **Whether the backup tiering in [ADR-0026](adr/0026-tiered-backups.md) was the right call.** Above roughly 20 GB,
  seventeen full archives would be the largest line in the bill. Below about 5 GB, full archives every session would
  have been fine and simpler.
- **Whether pruning is worth it** — unused dimensions, stale player data, over-explored regions — as a one-off on a
  copy, before the world is ever uploaded.

The *change* per session matters more than the absolute size for the frequent backup tier, because incremental
snapshots only store what changed. A mature world changes far less per evening than a fresh one, which works in our
favour.

### 5. Cold start: how long from container start to joinable

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
