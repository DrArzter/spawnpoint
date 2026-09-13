# ADR-0047 — Normalize preset sources before building

- Status: Accepted
- Date: 2026-09-13
- Amends: [ADR-0040](0040-reusable-presets-and-world-wipes.md) — Git is the first authoring source, not the permanent boundary

## Context

The release and catalog builders currently receive GitHub-specific repository, commit and staged-archive fields directly. Git review remains the supported authoring workflow today, but future installations may obtain presets from an internal editor or a manually supplied archive. Teaching the builders about every provider would duplicate trust checks and make a provider change alter release semantics.

## Decision

Every preset source enters through a source adapter. The adapter owns provider-specific authentication, allow-listing, retrieval and integrity checks, then produces one inert `profiles/` tree plus normalized source kind, origin and immutable revision metadata. The catalog and release builders consume only that normalized preset snapshot; they never call a provider or execute source-supplied code.

`github-snapshot` is the only enabled adapter now. It retains the current trusted-repository allow-list, exact Git SHA, S3 key binding and archive digest checks. No dashboard editor, manual upload path or additional provider is introduced by this decision. Adding one later means implementing and explicitly selecting another adapter while preserving the same validation and immutable-release boundary.

For compatibility, the current catalog and manifest schemas continue projecting the normalized origin and revision into their existing `repository` and `commit` fields. A schema rename belongs with the first non-Git adapter, when its concrete provenance requirements are known.

## Consequences

- Provider credentials and payload formats cannot leak into common release construction.
- A new source must define a stable origin and immutable revision and must prove the materialized bytes before the builders see them.
- GitHub-only assumptions remain inside one adapter instead of silently becoming requirements of every future source.
- Until a second adapter justifies a schema migration, some persisted field names remain Git-flavoured compatibility terms.
