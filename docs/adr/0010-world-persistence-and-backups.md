# ADR-0010 — World on a persistent EBS volume, backups to S3

- Status: Accepted
- Date: 2026-08-11
- Milestone: M1
- Amended by: [ADR-0026](0026-tiered-backups.md) — the per-session backup is an incremental EBS snapshot, not a full
  archive. Everything else here stands, including the save-and-quiesce rule and the graded retention

> **Amended.** This ADR assumed a modest world and made a full S3 archive the per-session backup. The world this project
> will host is an existing, long-played one, which makes seventeen full copies the largest line in the bill and adds
> billed upload time to every session. [ADR-0026](0026-tiered-backups.md) splits the mechanism into tiers. The reasoning
> below — why the world is separate from the instance, why retention is graded, why an untested restore is not a backup —
> is unchanged and is why that ADR exists.

## Context

The world is the only piece of state in this system that cannot be regenerated. Mods can be
re-downloaded, the instance can be rebuilt from Terraform, the site can be redeployed. Hundreds of hours
of building cannot.

Three failure modes have to be survived:

1. **Instance loss.** Spot interruption or a stop. Frequent by design. See [ADR-0004](0004-ec2-spot-for-the-game-server.md).
2. **Volume or region-level loss.** Rare, but total.
3. **Logical corruption.** A bad mod update eats chunks, or somebody uses a world edit tool badly. The
   damage is often noticed days later, which means the most recent backup may already contain it.

The third case is the one that decides the retention policy, and it is the one usually forgotten.

## Decision

The world lives on a dedicated EBS volume, separate from the root volume, mounted into the container.
The volume is not deleted when the instance terminates.

Backups go to S3 as archives of a saved, quiesced world, taken

- after every session, when the idle watchdog stops the server, and
- before every mod release promotion.

Retention keeps daily archives for a short window, then weekly, then monthly, so a corruption noticed two
weeks late is still recoverable. The bucket has versioning on and lifecycle rules that move older archives
to a colder storage class.

A restore is a documented procedure in the runbook, and it is tested at least once, deliberately, before
it is ever needed.

## Consequences

**Good**

- The frequent case — instance replacement — is a volume reattachment, with no restore and no data loss
  beyond the last save.
- Backups are independent of the volume, the availability zone and the instance.
- Graded retention covers late-discovered corruption, which is the failure mode most likely to actually
  destroy the world.
- Backing up at the two natural quiet points means the archive is always of a saved world, never a
  half-written one.

**Bad, or risky**

- The volume is tied to one availability zone, which constrains where a Spot instance can launch.
- An EBS volume kept for a stopped instance is billed continuously, unlike the instance. It becomes the
  main fixed cost.
- A backup taken while the server is writing is worthless, and it may look fine.
- Untested restores are not backups. This is the most common way to lose data despite having backups.

**Mitigations**

- Save the world and stop the container before every archive, and refuse to archive if the save fails.
- Size the volume tightly and grow it when needed. Prune old worlds and unused dimension data.
- Verify each archive after upload: listable, non-trivial in size, and containing the expected level data.
  Report the result to the chat channels.
- A restore drill is an explicit task in M1, and the runbook records how long it took.

## Alternatives considered

| Option | Why not chosen |
| --- | --- |
| World on the root volume | One volume to manage, but the world dies with any instance replacement, which happens constantly under Spot |
| World on EFS | Survives an availability zone and needs no reattachment, but noticeably slower for chunk I/O and more expensive per GB |
| EBS snapshots only, no S3 archives | Cheap and simple, and snapshots are incremental, but they are region-bound, awkward to inspect, and easy to accumulate unnoticed. Keep as a supplement, not the primary |
| The container image's own backup feature to a mounted path | Convenient, but leaves the backup on the same volume as the world, so it survives nothing that matters |
| Manual copies before risky changes | Better than nothing, and this is the M0 behaviour, but nobody remembers on an ordinary evening |

## Open questions

- Retention numbers. Start at 7 daily, 4 weekly, 6 monthly and revise once the world size is known.
- Whether a second copy in another region is worth the cost. Probably yes for the monthly archives only.
- Whether the world should also be exportable in a form a player can open locally, for map rendering.
