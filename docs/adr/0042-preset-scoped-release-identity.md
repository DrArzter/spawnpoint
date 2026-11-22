# ADR-0042 — Release identity and storage are scoped by preset

- Status: Accepted — amended 2026-11-22: a preset keeps its release history across revisions
- Date: 2026-09-10
- Amends: [ADR-0040](0040-reusable-presets-and-world-wipes.md)

## Context

The first implementation stored every build at `releases/<version>`. That accidentally made a bare version globally unique: `industrial@1.0`, `vanilla@1.0` and `factorio-vanilla@1.0` could not coexist even though releases belong to presets. Adding a dashboard selector on top of that layout would expose a release history that becomes ambiguous as soon as a second preset uses the same ordinary version number.

## Decision

**A release is identified by `(game, preset, version)` and stored under that namespace.** Human-facing shorthand is `preset@version` once the game is known. Immutable artifacts live below `releases/<game>/<preset>/<version>/`; a world generation stores its preset identity separately and may therefore retain the short version in its release state without ambiguity.

Preset discovery records the ordered set of successfully built versions, not only the newest one. World creation and a new wipe require an explicit version from that set. Runtime consumers derive the canonical artifact path from the world descriptor and generation release state; they do not search global legacy paths or guess a preset from manifest content.

The existing production release is copied and verified into its canonical namespace before readers switch. The old global object may remain as inert rollback material, but it is not a compatibility read path and receives no new writes.

## Consequences

- Different games and presets may independently publish `1.0` without collisions.
- A preset's release history is cheap catalog data and can drive an explicit dashboard selector.
- Builders, packs and host reconciliation must always carry game and preset identity alongside a version.
- The cutover needs a one-time migration, but the steady state has one canonical layout rather than dual readers.

## Alternatives considered

| Option | Why not chosen |
| --- | --- |
| Keep globally unique bare versions | Forces unrelated presets to coordinate numbering and contradicts ADR-0040's preset-owned release model |
| Add only a catalog history while artifacts remain global | Makes the UI appear correct but preserves the physical collision and blocks multi-game adoption |
| Use a random release UUID | Avoids collisions but discards the useful human version and still needs a preset relationship |

## Amendment — a preset keeps its release history across revisions (2026-11-22)

### Context

The catalog carried `build_status`, `releases` and `latest_release` over only while the profile digest was unchanged.
An edit to a preset's configuration changed the digest, the entry started empty, and every earlier release was
forgotten. In production the owner added two addons to Prominence II; the build of the new revision failed; the
panel said "Not built" while release `39127124115.1` still existed in S3 and the world ran on it.

### Decision

**The catalog lists every published release of a preset, whatever revision built it.** A revision is the profile
digest and its source commit.

- `releases` and `latest_release` are the newest published releases of all revisions. A release is published when its
  manifest exists; a folder without a manifest (a failed build) is never listed.
- `build_status` is the state of the current revision only: `unbuilt`, `building`, `failed` or `ready`.
- A new optional map, `built_from`, records `{profile_digest, source_commit}` for each release. A release whose digest
  differs from the entry's own is **older**. A release recovered without its revision has `profile_digest: null` and
  is older. A legacy entry without the map keeps its meaning: all its releases are current.
- `schema_version` stays 2. The change only adds a field and relaxes the carry-over. A reader that ignores
  `built_from` sees an entry with releases, a `latest_release` that is among them, and a status that is not `ready`:
  all of this was already valid. Such a reader refuses promotion while the status is not `ready`, which is the safe side.

The catalog builder carries `releases`, `latest_release` and `built_from` over for every entry whose id it knew,
and marks each earlier release with the old entry's digest and commit. A digest change starts `unbuilt`. The
builder also lists `releases/<game>/` and adds every release that has a manifest and that the catalog forgot, so the
history of a catalog written before this amendment heals at its next publish. The listing is best effort. The release
builder appends the new release with the current digest and commit, as before.

Readers decide by release, not by the entry's status alone:

| Use | Older-revision release | Why |
| --- | --- | --- |
| Start, restore and download for a world that exists | Allowed | The world runs on it. Nothing changed for the world. |
| Promotion of a fleet world (ADR-0078) | Allowed while the current revision is not ready | Exactly as before the digest change. A current-revision release still needs `ready`. |
| New world | Refused (`release_outdated`) | A new world should not start on a pack that the configuration has left. |
| New wipe | Refused (`release_outdated`) | The same. |

Refusing is the safer default and keeps today's behaviour for new worlds. It costs a build of the new revision
before the next wipe. The owner can reverse this rule later in one place (`usableByNewWipe`).

The panel shows the release as ready and the new revision's build as a second compact indicator
("New revision: build failed"), in both skins.

### Consequences

- A failed or pending build of a new revision no longer hides a release that a world runs on.
- The release list keeps growing. The panel already shows only the newest few.
- A release recovered from S3 has no known digest. It is marked older, even if it was built from the current one.
- The release-builder role needs `s3:ListBucket` on the bucket, limited to the `releases/` prefix.
- A catalog is healed at the next catalog publish (a push to the configuration repository), not at the next build.
