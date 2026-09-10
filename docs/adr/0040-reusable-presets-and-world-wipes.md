# ADR-0040 — Reusable presets create worlds whose wipes own release state

- Status: Accepted
- Date: 2026-09-10
- Supersedes: [ADR-0039](0039-git-presets-instantiate-world-generations.md)
- Amends: [ADR-0023](0023-multiple-worlds.md) and [ADR-0030](0030-desired-and-active-release.md)

## Context

ADR-0039 separated preset, world and generation identities, but its first-start flow still treated a discovered preset as a not-yet-created world and consumed the preset after creating one world. That prevents two independent worlds from sharing the same mod configuration. It also leaves desired and active release pointers at world scope, although a long-lived world may have several save lineages created months apart from different releases.

A preset such as `industrial` is reusable authoring input. A release such as `industrial@2.1` is one immutable resolution of its exact game, loader, mod and configuration versions. Rostik's and Gosha's worlds may both use that preset, start from different releases, and progress through independent wipes.

## Decision

**Presets, releases, worlds and world generations are separate identities with explicit many-to-one relationships.** A preset may produce many releases and instantiate many worlds. A release may be used by many worlds or generations. A world owns an ordered history of generations and has exactly one open generation while it is playable.

The dashboard creates a world explicitly from a selected release. Starting a session never implicitly creates a world, and a created world never consumes or hides its preset. The release page may offer **Create world from this release**, but the new world's durable parent is the preset, not that release: its open generation may later promote to another compatible release of the same preset.

**Release state belongs to the open world generation.** A generation records the release from which it was created and owns its desired and active release pointers. Promoting a compatible release updates the existing save lineage; it does not by itself create a new generation. A closed generation retains enough release history to explain and reproduce its backups.

**A new generation is a wipe.** Player-facing surfaces use `wipe`: **Current wipe**, **Wipe history**, and **Start new wipe**. Internal contracts retain `WorldGeneration`, because `wipe` names both a period and the action that starts the next one. Starting a new wipe safely stops an active session, creates and verifies a final backup, closes the current generation, and creates a fresh generation from an explicitly selected ready release. Restoring a backup also creates a new generation rather than overwriting either the source or current lineage. Every backup records both its generation and the release that produced it.

Navigation follows identities rather than collection labels. A world route reads `Game / Preset / World name`; a generation route may append `Wipe #N`. `Worlds` is not a breadcrumb segment. Release details remain a linked view under the preset instead of becoming a permanent ancestor of the world.

Different release age alone does not require different presets. If two worlds intentionally need different mod composition, they use distinct presets. Per-world ad-hoc mod overrides are not allowed: Git remains the only authoring surface and every effective configuration must build into an immutable release. Single-parent preset composition (`extends`, add, remove and adapter-validated overrides) remains a candidate for a later decision; it is not implied by this ADR.

## Consequences

- World IDs can no longer be derived from preset IDs, and the catalog cannot mark a preset consumed after the first world.
- World creation requires an explicit API operation carrying a preset, release, world identity and display name.
- Desired and active pointers must be keyed by world generation. Existing world-scoped records are migrated into an explicit first generation before runtime cutover; compatibility reads are migration input, not a second live source.
- A backup restore can recover the exact mod environment that produced the save instead of guessing from the world's latest release.
- The interface can expose multiple worlds under one preset without turning old releases into navigation parents.

## Alternatives considered

| Option | Why not chosen |
| --- | --- |
| One preset creates at most one world | Conflates reusable configuration with persistent player state and forces duplicate presets for ordinary second worlds |
| Any release change creates a generation | Conflates deploying compatible mod updates with wiping save data and makes routine upgrades fragment world history |
| Desired and active release remain on the world | Cannot accurately describe two generations created from different releases or restore an old backup reproducibly |
| Allow dashboard-only overrides per world | Creates an unreviewed second configuration source and breaks reproducible releases |
