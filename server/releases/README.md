# Release manifests

Each immutable release is stored as `<version>/manifest.json`. Its payload has the same root and contains the JARs
under `mods/` when staged on a server or published to the release bucket.

Manifest schema version 1 records:

- `release` in `MAJOR.MINOR` form;
- the Minecraft, loader type and exact loader version;
- creator, UTC creation time and changelog;
- every server JAR's basename, byte size and SHA-256 digest.

The mod array may be empty. That is how a vanilla-like profile running on a Forge kernel is represented: the loader is
still exact, while reconciliation atomically removes every stale JAR and records the empty release marker. A release
built from the profile repository also records its profile ID, origin URL and full Git commit as `source_profile`.

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

Build from a clean profile checkout when profile provenance is available:

```bash
server/scripts/build-profile-release.sh \
  /path/to/my-docker-minecraft-server-config/profiles/main \
  1.0 /path/to/resolved/mods /tmp/main-1.0/manifest.json
```

Resolve a CurseForge source list locally without starting Minecraft, then build the manifest from those exact bytes:

```bash
PROFILE_ENV_FILE=/path/to/private/.env \
  server/scripts/resolve-profile-mods.sh \
    /path/to/my-docker-minecraft-server-config/profiles/main \
    /tmp/main-1.0/mods

server/scripts/build-profile-release.sh \
  /path/to/my-docker-minecraft-server-config/profiles/main \
  1.0 /tmp/main-1.0/mods /tmp/main-1.0/manifest.json
```

Keep that dotenv file private (`chmod 600 /path/to/private/.env`); it is an authoring-machine secret and is never
copied into a release.

The resolver delegates to the digest-pinned image's `mc-image-helper curseforge-files` command. It passes the API key
only as container environment, downloads into a sibling stage, and refuses to overwrite a previous output. The game
host later consumes uploaded hashes and bytes; it does not need a CurseForge API key or resolve moving URLs at boot.

For `vanilla-forge`, pass an existing empty mods directory. A profile declaring a mod source refuses an empty resolved
directory, and an empty-mod profile refuses supplied JARs. Uncommitted changes below the profile directory are refused,
so the embedded commit always describes the inputs that were actually built.

Apply a staged release to a disposable target:

```bash
RELEASE_SOURCE_DIR=/path/to/release-payload \
  server/scripts/reconcile-release.sh server/releases/1.0/manifest.json /tmp/test-mods
```

Reconciliation verifies the source and copied bytes before replacing the destination directory with a same-filesystem
rename. The old directory is restored if the commit step fails. The destination contains
`.spawnpoint-release.json`, so the installed state is inspectable without consulting the control plane.
