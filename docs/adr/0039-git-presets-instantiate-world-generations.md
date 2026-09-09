# ADR-0039 — Git presets instantiate recoverable world generations

- Status: Accepted
- Date: 2026-09-02
- Extends: [ADR-0023](0023-multiple-worlds.md), [ADR-0028](0028-update-proposals.md), and [ADR-0030](0030-desired-and-active-release.md)

A game's configuration repository is the only authoring surface for presets. A validated Git revision produces an immutable release and publishes preset metadata to the release store; the dashboard reads that catalog through the control plane. The dashboard does not accept configuration or mod archives, and it does not call GitHub directly. Operator-side import and backfill tools remain available for adopting existing data and repairing historical releases, but are not a second authoring path.

A preset may be visible before it has a world. Starting it for the first time creates a named world and its first generation from the preset's latest ready release. Starting it again loads that generation's persisted save. A preset without a ready release is visible but cannot start, so a failed build cannot silently become a vanilla or partially configured world.

Regeneration is explicit and recoverable: stop the active session if necessary, create and verify a final backup of the current generation, close it, and create a fresh generation from the selected ready release. Archive removes a world from normal use while preserving its generations and backups. Purge is a separate destructive operation, available only after Archive and only after the owner types the exact world ID. It permanently removes the registry record, release pointer and every version of the world's S3 backups. A retained purge marker names the generations whose now-unreferenced EBS directories the host removes on its next boot; purge never starts a stopped instance merely to reclaim local cache space.

This chooses Git review and one deterministic build path over the convenience of uploading an already assembled pack in the dashboard. It also chooses lazy world creation over provisioning a save for every discovered preset: Git may contain experiments that are never played, while persistent storage and backup lineages begin only when somebody starts one.

## Consequences

- Preset identity, world identity and generation identity must be carried separately; code must not infer one from another.
- The preset catalog is derived state and can be rebuilt from the configuration repositories. Releases, saves and backups remain durable records.
- Existing worlds remain valid even if their preset is later removed from Git. They become orphaned from authoring, not deleted.
- Changing a preset creates a new release; it never mutates an existing world's save or release in place.
