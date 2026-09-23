# ADR-0052 — Keep a release while a generation names it, and check before restoring

- Status: Accepted — restore preflight enforced at request and workflow boundaries, 2026-09-23; retention rule applies to any future release cleanup
- Date: 2026-09-16
- Milestone: M4
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
