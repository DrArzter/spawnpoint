# ADR-0026 — Tiered backups: frequent incremental snapshots, infrequent full archives

- Status: **Rejected**
- Date: 2026-08-11
- Rejected: 2026-08-11, the same day, on measurement
- Milestone: M1
- Would have amended: [ADR-0010](0010-world-persistence-and-backups.md), whose original design stands unchanged

> **Rejected, because the problem does not exist at this scale.** This ADR was written on the assumption that the
> existing world was tens of gigabytes. It is roughly 200–300 MB. Seventeen full archives of that is under half a
> gigabyte, costing pennies a month, and a 300 MB upload finishes in seconds — so it neither dominates the bill nor
> meaningfully extends billed instance time, and it fits comfortably inside the two minutes a Spot interruption gives.
> [ADR-0010](0010-world-persistence-and-backups.md)'s full archive after every session is simply correct here.
>
> **Kept, because the analysis defines the trigger.** Everything below is right *if* a world ever grows large. The
> threshold is around **30 GB** — retention was since cut from seventeen copies to nine, which raises it — where full
> copies start to exceed every other line in
> [docs/costs.md](../costs.md) combined. If any world approaches that — a heavily explored world, or several worlds
> sharing one lineage — reopen this as a new ADR rather than re-deriving it.
>
> The parts below that are worth doing anyway, independent of size: pruning the world once before upload, and
> compressing the archive.

## Context

[ADR-0010](0010-world-persistence-and-backups.md) was written assuming a modest world. It archives the whole world to
S3 after every session and before every release, with graded retention: daily for a week, then weekly, then monthly.

An existing, long-played world changes the arithmetic, and there is one already — it is the world this project will
host, not a fresh one to be generated.

**Storage multiplies by the retention count.** Graded retention of 7 daily, 4 weekly and 6 monthly copies is 17
archives. At the placeholder rate in [docs/costs.md](../costs.md) of $0.023 per GB-month:

| World size | 17 full archives | Monthly, at placeholder rates |
| --- | --- | --- |
| 5 GB | 85 GB | ~$2 |
| 20 GB | 340 GB | ~$8 |
| 40 GB | 680 GB | ~$16 |

The current model totals roughly $8.80 a month. So for anything above about 20 GB, **the backups alone become the
largest line in the bill** — larger than the volume, which was previously the dominant fixed cost, and far larger than
the compute. Compression helps, and it does not change the shape.

**Archive time is billed instance time.** The world can only be uploaded while the instance is running, so a long
upload extends every session's billed hours by however long it takes. Worse, the Spot interruption path has about two
minutes, which is not enough to upload a large world at all — [ADR-0010](0010-world-persistence-and-backups.md) already
degrades gracefully there, but it means the interruption path and the normal path would use different mechanisms.

**EBS snapshots are incremental by design.** After the first, only changed blocks are stored. An evening of play on a
mature world changes a small fraction of it, so a snapshot costs a small fraction of a full archive. Snapshots also
complete **asynchronously after the instance stops**, which removes the upload from billed instance time entirely.

[ADR-0010](0010-world-persistence-and-backups.md) considered snapshots and rejected them as the primary mechanism —
correctly, for the reasons it gave: they are region-bound, awkward to inspect, and easy to accumulate unnoticed. Those
objections apply to snapshots as the *only* mechanism. They do not argue against snapshots as the *frequent* one.

## Decision

Two tiers, each doing what it is good at.

| Tier | Mechanism | When | Purpose |
| --- | --- | --- | --- |
| Frequent | EBS snapshot of the data volume | After every session, and before every release promotion | Cheap, incremental, and free of billed upload time. The everyday recovery point |
| Durable | Full compressed archive to S3 | Monthly, and before anything structurally risky such as a version upgrade | Inspectable, portable, independent of the volume and the availability zone |

Retention: keep snapshots on the graded schedule from [ADR-0010](0010-world-persistence-and-backups.md), and keep far
fewer full archives — a handful, not seventeen. The graded schedule still exists to cover corruption noticed late,
which is its whole purpose; it is now served by snapshots.

Both tiers still require the world to be **saved and quiesced first**. That rule is unchanged and is the one that
matters most: a snapshot of a world mid-write is as worthless as an archive of one.

Additionally, because volume size is the dominant fixed cost and this world is already large:

- **Measure before sizing.** See [docs/measurements.md](../measurements.md).
- **Prune deliberately.** Unused dimension data, stale player data and over-explored chunk regions are worth removing
  once, as a documented one-off, before the world is uploaded — not repeatedly as a habit.
- **Compress the durable archive.** Region files compress usefully, and this tier is infrequent enough that the time
  cost does not matter.

## Consequences

**Good**

- Backup cost stops scaling with world size times retention count, which is what would otherwise have made this the
  largest line in the bill.
- Sessions stop paying instance time for an upload. The stop path becomes: save, quiesce, stop, and let the snapshot
  finish by itself.
- The interruption path and the normal path now use the same mechanism, because a snapshot can be triggered in the two
  minutes available where an upload cannot.
- Restore from the frequent tier is a volume created from a snapshot, which is faster than downloading and unpacking an
  archive.
- The durable tier keeps everything [ADR-0010](0010-world-persistence-and-backups.md) wanted from S3: something
  inspectable, portable, and not tied to the volume.

**Bad, or risky**

- Two mechanisms to implement, verify and test restoring from. Two restore drills, not one.
- Snapshots are region-bound, so the durable tier is the only protection against losing the region — and it is now the
  infrequent one, which means the worst-case recovery point is older than before.
- Incremental snapshots share blocks, so deleting one does not free what it appears to. Reasoning about snapshot
  storage cost is genuinely unintuitive.
- Snapshots accumulate silently. This was one of ADR-0010's objections and it still applies; it now needs a lifecycle
  policy rather than a decision not to use them.
- Verifying a snapshot is harder than verifying an archive. "Listable and the right size" does not apply.

**Mitigations**

- Snapshot lifecycle managed as code with an explicit retention policy, so accumulation is bounded by configuration
  rather than by vigilance.
- Restore drills for **both** tiers in M1, each recorded in the runbook with how long it took. An untested tier is not a
  tier.
- Verification for the frequent tier is a periodic real restore, not an inspection — which is the only verification that
  ever meant anything anyway.
- Keep the durable tier frequent enough that losing a region does not lose a season. Monthly is the starting point;
  revisit once the real world size and change rate are known.

## Alternatives considered

| Option | Why not chosen |
| --- | --- |
| Full archive every session, as [ADR-0010](0010-world-persistence-and-backups.md) had it | One mechanism, trivially inspectable, and the right answer for a small world. For a large one it becomes the biggest line in the bill and adds billed upload time to every session |
| Snapshots only | Cheapest and simplest, and enough for the common case. Leaves nothing inspectable or portable, and nothing that survives losing the region |
| Incremental file-level backup to S3, with deduplication | Gets snapshot-like economy with S3's inspectability — the technically best answer. Needs a real backup tool on the instance, its own state, and its own failure modes. Reconsider if the two-tier split proves annoying |
| Shorter retention on full archives instead of tiering | Simplest change to make. Directly trades away recovery from late-noticed corruption, which is the failure most likely to destroy the world |
| Rely on the world being on a persistent volume | Not a backup. Survives instance replacement and nothing else |

## Open questions

- Actual world size, change rate per session, and how well it compresses. All three are measurements, and the first is
  available immediately. See [docs/measurements.md](../measurements.md).
- Whether the durable archive should be copied to a second region. Probably yes for the monthly tier only.
- Whether pruning the existing world before upload is worth the risk of removing something wanted. Do it on a copy,
  never on the original.
- How the per-world backup lineage in [ADR-0023](0023-multiple-worlds.md) maps onto snapshots, given one volume holds
  every world. A snapshot captures all worlds at once, which is cheaper but coarser than one lineage per world.
