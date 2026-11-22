# ADR-0052 — Keep a release while a generation names it, and check before restoring

- Status: Accepted — restore preflight enforced at request and workflow boundaries, 2026-09-23; retention rule applies to any future release cleanup; amended 2026-11-22: a backup is paired with the release that ran
- Date: 2026-09-16
- Milestone: M4
- Amended by: [ADR-0080](0080-store-release-files-by-content.md) — holders in a reference table, retirement with
  `holders = 0`, and a release in state `retiring` or `retired` is not used again
- Relates: [ADR-0042](0042-preset-scoped-release-identity.md) (the namespace a release is stored under),
  [ADR-0040](0040-reusable-presets-and-world-wipes.md) (the generation that names it),
  [ADR-0010](0010-world-persistence-and-backups.md) (the archive that is useless without it),
  [ADR-0028](0028-update-proposals.md) (which will cut releases on a schedule and therefore create the pressure to
  delete them)

## Context

A backup is not a world. It is world data **plus the release it ran**, and restoring reinstates the pair: the restored
generation takes its release from the generation the archive came from, not from whatever the world runs today. That is
what makes it correct to restore a year-old archive onto a world that has moved on four releases since.

The pairing is enforced carefully on one side and not at all on the other. A restore checks that the backup key is
shaped correctly, that it carries the checksum and the generation id, and that the generation is one this world
actually had; an unknown generation is refused rather than guessed. It never checks that the **release** named by that
generation is still in the release store.

Nothing deletes releases today. `infra/terraform-releases` declares no lifecycle rule and no expiration, so every
release ever built is still there. The world records are therefore correct by luck: they are kept honest by the absence
of a cleanup rather than by a decision that there should not be one. The release store is budgeted at 10 GB and $0.23 a
month, so nothing has yet made anybody want to prune it.

[ADR-0028](0028-update-proposals.md) changes that pressure. Updates arrive as scheduled proposals that write a
**candidate release to the store before anybody approves it**, so the store starts growing at the rate upstream authors
publish rather than the rate the owner decides to upgrade. The first person to look at that growth will write a
cleanup, and the obvious cleanup — delete releases older than N — silently destroys the only way to open every archive
taken on them.

## Decision

**A release is retained for as long as any generation of any world names it**, current or previous. Deleting one that is
still named is not a cleanup; it is destroying the archives that depend on it, at a distance, without touching them.

Any cleanup that is ever written computes the named set from the world records and subtracts it. **Nothing is deleted by
age alone.** A release that no generation names may go; a release from 2025 that one archived generation still names
stays.

**A restore verifies the release exists before it writes the new generation.** The check belongs where the decision is
made, not where it is executed: today the failure would surface at the next start, in release reconciliation, with the
world already pointed at a generation that cannot be brought up. Checking first means the operator is told no while
they are still looking at the button, and the world is untouched.

## Consequences

**Good**

- An archive stays restorable for as long as the panel is willing to list it. Those two facts stop being independent.
- The failure moves from a reconciliation step nobody was watching to the moment somebody asked for it, where it can be
  explained in terms of the thing they asked for.
- A future cleanup has a rule to obey, written before it exists rather than after it has deleted something.

**Bad, or risky**

- Retention grows monotonically with generations. A world with many wipes pins many releases, and no amount of storage
  policy can shrink that without making its archives unopenable.
- The rule protects promoted releases and candidates equally, because it cannot tell them apart — a candidate is named
  by nothing, so it is unprotected, which is right, but it means the rule offers no help at all with the growth
  [ADR-0028](0028-update-proposals.md) will cause.

**Mitigations**

- The existence check is one object head on the manifest, on a path the record already knows. It costs nothing worth
  measuring.
- The named set is computed from world records the API already reads, so a cleanup needs no new source of truth.
- Purging a world already deletes its generations, so the named set shrinks when a world is genuinely retired — which
  is the only time it should.

## Alternatives considered

| Option | Why not chosen |
| --- | --- |
| Leave it as it is: nothing deletes releases | Works exactly until somebody writes a cleanup, and then fails silently, later, and in a way nobody connects to the cleanup |
| Copy the release into every archive | Makes each backup self-contained, at the cost of storing the whole mod set once per archive. That duplication is absent today and worth keeping absent |
| Fall back to the newest release when the named one is missing | Loads a world with mods it was not saved with. In Minecraft that deletes the blocks and items those mods owned, permanently, and it looks like a successful restore |
| Check the release at start instead of at restore | Where it happens today. The world is already repointed by then, and the person who caused it is no longer watching |

## Open questions

- Whether a candidate release from a proposal that was never approved is worth keeping as evidence of what was
  considered, or is exactly the garbage a cleanup should collect.
- Whether the check should verify the manifest's digests as well as the release's presence, or whether presence is the
  honest limit of what can be proven cheaply at the moment somebody presses a button.

## Amendment — a backup is paired with the release that ran (2026-11-22)

The Context above says "the restored generation takes its release from the generation the archive came from". That
was true only while a wipe ran one release. A promotion changes the release pointer of a wipe
([ADR-0030](0030-desired-and-active-release.md)) and does not change the generation's `release` in the world record,
which stays the release the wipe began with (its origin). The host also wrote the origin release on each archive. So a
backup taken on 4.1.9, after a promotion from 4.1.4, restored onto 4.1.4 and loaded without the mods it was saved with.
That is the failure this ADR exists to prevent.

**Decision.**

1. **Each wipe records the releases it ran.** Every commit of an active release, at a start or at a promotion, appends
   the release to `releases_run: [{release, since}]` on the wipe's pointer
   (`worlds/<id>/generations/<gen>/release.json`) when it differs from the last entry. `since` is the commit time. The
   field is absent on pointers written before this amendment.
2. **The host writes the release that ran on each archive.** At each stop the host reads the wipe's pointer and writes
   its `active_release` as the archive's `release` metadata, with `release-source=active`. When the pointer cannot be
   read or has no active release, the host writes the origin release, as before, with `release-source=generation`.
3. **A restore uses the release of the backup.** It takes, in this order: the archive's `release` when
   `release-source=active`; else the entry of the source wipe's `releases_run` that began last at or before the time the
   archive was stored (the oldest entry when the archive is older than all of them); else the source wipe's
   `active_release`; else its origin release. The existence check of this ADR applies to that release, before the new
   generation is written. The restored generation names that release.
4. **The panel shows it.** Each listed backup carries the release a restore would use and where it came from
   (`recorded`, `ran` or `origin`). The restore dialog names the release.
5. **The named set grows.** A release is named when any generation names it **or** any wipe's `releases_run` lists it.
   A future release cleanup reads both.

**Consequences.**

- Good: a restore after a promotion loads the save with the mods it was saved with. A rollback after a damaging update
  is a restore of the pre-promotion backup (ADR-0030, amended).
- Bad: an archive taken before this amendment, on a wipe promoted before this amendment, has no reliable record of the
  release that ran. The fallback can pick the wrong release. The runbook tells the operator to check the dialog and to
  restore such an archive by hand.
- Bad: listing backups costs one `HEAD` per listed archive (at most 20) and one pointer read per wipe. The world
  lifecycle role may now `GetObject` world archives, because S3 authorises `HEAD` that way; the handler reads metadata
  only.

**Alternatives considered.**

| Option | Why not chosen |
| --- | --- |
| Change the generation's `release` in the world record at each promotion | Loses the origin, and the world record is written by other paths; the pointer is the record of what ran |
| Infer the release only from `releases_run` and the archive time | Works without metadata, but the archive time and the commit time can disagree by a session; the host knows the active release at the stop |
| Put the release in the archive's key | Changes the key format that restore, retention and prepare-world.sh parse |
