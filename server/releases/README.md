# Release manifests

Each immutable release is stored as `<version>/manifest.json`. Its payload has the same root and contains the JARs
under `mods/` when staged on a server or published to the release bucket.

Manifest schema version 1 records:

- `release` in `MAJOR.MINOR` form;
- the Minecraft, loader type and exact loader version;
- creator, UTC creation time and changelog;
- every server JAR's basename, byte size and SHA-256 digest.

SHA-256 plus byte length is the deployment identity. Future builders may add embedded mod IDs, display versions and
CurseForge/Modrinth file IDs, but reconciliation must ignore those descriptive fields when deciding whether bytes are
correct. Metadata extraction is necessarily best-effort: one JAR can expose multiple components, placeholders or a
non-SemVer version. See [ADR-0008](../../docs/adr/0008-versioned-mod-releases.md).

Create a manifest from a known-good directory:

```bash
RELEASE_CREATED_BY=owner RELEASE_CHANGELOG='Initial known-good pack' \
  server/scripts/build-release-manifest.sh \
  1.0 1.20.1 47.4.10 /path/to/mods server/releases/1.0/manifest.json
```

Apply a staged release to a disposable target:

```bash
RELEASE_SOURCE_DIR=/path/to/release-payload \
  server/scripts/reconcile-release.sh server/releases/1.0/manifest.json /tmp/test-mods
```

Reconciliation verifies the source and copied bytes before replacing the destination directory with a same-filesystem
rename. The old directory is restored if the commit step fails. The destination contains
`.spawnpoint-release.json`, so the installed state is inspectable without consulting the control plane.
