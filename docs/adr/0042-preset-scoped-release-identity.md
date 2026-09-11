# ADR-0042 — Release identity and storage are scoped by preset

- Status: Accepted
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
