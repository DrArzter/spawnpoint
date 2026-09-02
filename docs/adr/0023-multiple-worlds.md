# ADR-0023 — Several worlds, one instance, one of them active at a time

- Status: Accepted
- Date: 2026-08-11
- Milestone: M2/M3 — prioritised after the first working on-demand session
- Amended by: [ADR-0030](0030-desired-and-active-release.md), [ADR-0039](0039-git-presets-instantiate-world-generations.md)
- Extends: [ADR-0008](0008-versioned-mod-releases.md), [ADR-0009](0009-s3-as-mod-source-of-truth.md), [ADR-0010](0010-world-persistence-and-backups.md)

## Context

The intention is several packs, not one: vanilla-plus, techno, magic, techno-magic. Each is a different mod set,
each wants its own save data, and the group wants to start whichever one they feel like.

Everything so far assumes exactly one of everything: one pair of desired and active release pointers, one world directory, one backup
lineage, one hostname. The question is whether that assumption is load-bearing.

Mostly it is not, and that is the payoff of [ADR-0008](0008-versioned-mod-releases.md). Immutable artefact plus a
mutable pointer plus reconcile-on-boot generalises by adding a dimension. These mechanisms need no redesign:

| Mechanism | How it generalises |
| --- | --- |
| Immutable releases and versioning | Each world gets its own release line. `techno 1.4` and `magic 2.0` are independent |
| Promotion, health check, automatic rollback | Already parameterised by "which release"; becomes "which release of which world" |
| Boot-time reconciliation | Reconciles against the desired release *of the world being started*; commits active only after health checks |
| Backup, verification, graded retention | One lineage per world instead of one lineage |
| Link table, whitelist projection | Unchanged. Authorisation is about people, not worlds |
| Idle watchdog, Spot interruption handling | Unchanged. They act on the running server, whichever world it is |

Three things do have to change, and they are the substance of this ADR: a named entity has to exist, the storage
layout has to gain a dimension, and something has to decide which world is running.

## Terminology

**World** here means the whole named playable thing: a name, a release line, its save data, and its backup
lineage. Not just the save files.

That overloads the word slightly, and it is still the best available. "Realm" collides with Minecraft Realms, a
paid Mojang product, which would confuse exactly the audience that matters. "Server" and "instance" are already
taken in this repository by the EC2 host and the game process. "Pack" describes the mod set alone and says
nothing about the save data — and the point of this entity is that the two are inseparable, because a pack cannot
be swapped under a save without a migration.

## Decision

**A world is a first-class entity.** Everything that was singular becomes keyed by world:

```
releases/<world>/<version>/manifest.json     immutable, per world
worlds/<world>/desired.json                  requested release, per world
worlds/<world>/active.json                   last health-checked release, per world
mods/<sha256>                                content-addressed, shared across all worlds
backups/<world>/...                          one lineage per world
```

**Mod binaries become content-addressed.** [ADR-0008](0008-versioned-mod-releases.md) left this open. Four packs
that share a large overlap of common library mods settles it: store by hash once, reference from every release
that uses it.

**Content-addressed, not a "common" directory.** The tempting version is a `common/` folder for mods several packs
share, with per-pack folders for the rest. It is the weaker form of the same idea: it needs somebody to decide what
counts as common, that judgement drifts as packs change, and it creates two places to look. Addressing by hash removes
the decision entirely — two releases referencing the same file share it automatically and exactly, while two versions of
the same mod are different hashes and cannot collide.

**The same cache on the instance, materialised by hardlink.** Forge reads real files from `mods/`, so reconciliation has
to turn hashes into named JARs. Keep a content-addressed cache on the data volume and **hardlink** from each world's mod
directory into it rather than copying. Four worlds sharing eighty mods then use one copy on disk instead of four.

That second part is where the idea actually pays, and not in money. **Switching worlds becomes relinking rather than
re-downloading** — at 111 mods and several hundred megabytes, that is the difference between a switch that fetches and
one that does not. See the reconciliation step in [ADR-0009](0009-s3-as-mod-source-of-truth.md).

**Worth being honest about the storage saving itself: it is pennies.** Four packs at roughly 500 MB with heavy overlap
is perhaps 2 GB naive against 800 MB deduplicated — about **three cents a month**. Content-addressing is not adopted to
save that. It is adopted because it is *simpler* than classifying mods as common or not, and because of the hardlink
consequence above.

**One EBS volume, a directory per world.** Not a volume per world. The volume is the dominant fixed cost in
[docs/costs.md](../costs.md), and four volumes would multiply it while three of them sit unused. A directory per
world costs only the bytes it holds.

**One world is active at a time.** The start operation takes a world as a parameter. Switching worlds is: save,
archive, stop, then start the other one. Two modded servers at once would need double the memory on a much larger
instance, and the group is one group — it plays one thing on a given evening.

**One connection string per world**, where the connectivity mode supports names — a hostname per world in DNS
mode, an overlay name per world in overlay mode. Players keep a stable server-list entry per world. On start, only
the started world's name is pointed at the running server and the others are retracted, so connecting to a world
that is not running fails cleanly rather than silently landing in whichever world happens to be up. In the
announce-the-raw-address mode there are no per-world names, and the surfaces state which world is running. See
[ADR-0024](0024-connectivity-modes.md).

**Surfaces gain the parameter, not new logic.** `/start techno` in the bots; the panel lists worlds with status,
live version and when each was last played; the pack site publishes a client pack per world per version.

**The whitelist stays global.** Being an authorised player is about the person, not about which world. Per-world
access is an unnecessary distinction for one group of friends. See [ADR-0022](0022-minecraft-account-as-linked-identity.md).

## Cost impact

Worth stating plainly, because it is better news than it sounds.

- **Compute does not change.** One instance, one world running, so the variable cost is identical to the
  single-world design. Four idle worlds cost nothing in compute.
- **Storage grows roughly linearly** with the number of worlds: save data plus its backup lineage per world. At
  the placeholder rates in [docs/costs.md](../costs.md), four worlds add single-digit US dollars per month.
- **Mod storage grows sub-linearly**, because content-addressing shares the overlap between packs.

So the on-demand design is what makes several worlds affordable: their cost is storage, not compute.

## Consequences

**Good**

- Four packs for roughly the price of one, because only one runs at a time.
- Each world has independent versioning and rollback. Breaking techno cannot touch magic.
- Experimenting is cheap. A new pack is a new world, and abandoning it is a deletion, not an unpicking.
- Backups are already per world, so restoring one cannot damage another.
- Nothing in the existing mechanisms is redesigned. The dimension is added, not the machinery replaced.

**Bad, or risky**

- Every path, prefix and operation gains a parameter, and a missing or wrong one is dangerous: reconciling
  techno's mods against magic's save is the failure that eats a world.
- Switching worlds is slow. Stop, archive, start — a cold start plus an archive upload before anybody plays.
- Only one at a time. Two people wanting different worlds on the same evening cannot both be served.
- Four worlds means four packs for players to install and keep straight, and four changelogs to write.
- Disused worlds accumulate. Storage grows quietly, which is exactly how a small bill becomes a surprising one.

**Mitigations**

- The world parameter is required everywhere, never defaulted. An operation with no world fails rather than
  guessing. This is the single most important rule in this ADR.
- Reconciliation verifies that the world directory it is about to touch matches the release it is applying, and
  refuses on mismatch. Cheap check, prevents the worst outcome.
- The panel shows each world's last-played date, so disuse is visible; archive and remove a world deliberately,
  as a documented runbook step.
- Announce a world switch in chat before stopping, exactly as a release promotion does.
- If two worlds at once ever becomes a real need, everything is already parameterised by world, so a second
  instance is a configuration change rather than a redesign. Do not build it before somebody asks.

## Alternatives considered

| Option | Why not chosen |
| --- | --- |
| One world only, as today | Simplest, and correct until the second pack exists. The second pack does exist, so this is being decided now rather than retrofitted |
| All worlds running concurrently on one large instance | Nobody waits for a switch. Needs memory for every pack simultaneously, so a much larger instance running whenever anybody plays anything — the one cost the whole design exists to avoid |
| One on-demand instance per world | Genuinely reasonable, and it does allow two worlds at once while keeping each stopped when idle. Rejected for now: it multiplies the per-world fixed cost by adding a volume each, and it complicates the idle watchdog and the hostname handling for a need nobody has expressed |
| A separate volume per world | Cleaner isolation, and it would allow a world to be detached and moved. Multiplies the dominant fixed cost by the number of worlds, most of which are idle |
| A separate Terraform stack per world | Complete isolation, and four times the infrastructure, four times the cost and four times the maintenance |
| Distinct ports on one instance instead of distinct hostnames | Avoids the DNS handling, but asks players to remember port numbers, and modded servers on one host still compete for memory |

## Open questions

- Whether retracting the names of non-running worlds is the right behaviour, or whether they should resolve to
  something that returns a useful message. A stale name pointing at a live server running a different world is the
  failure to avoid; retracting is the crude, safe version. See [ADR-0024](0024-connectivity-modes.md).
- Whether a world may declare its own connectivity mode and `online-mode` setting. Both are per-world in principle,
  and only one mode can be active on one instance at a time. See [ADR-0022](0022-minecraft-account-as-linked-identity.md).
- Whether a MAJOR release — a Minecraft or loader version change — should create a new world rather than migrate
  the existing one. For a big jump, a new world is often what the group actually wants.
- Whether the idle watchdog needs per-world state, or whether "the running server" is sufficient. Probably
  sufficient, since only one runs.
- How a world is retired: archived to cold storage and removed, or kept indefinitely. Needs a decision before the
  first abandoned pack, not after.
- Whether the panel should show a per-world player history, which would need the Minecraft binding from
  [ADR-0022](0022-minecraft-account-as-linked-identity.md) read per session.
