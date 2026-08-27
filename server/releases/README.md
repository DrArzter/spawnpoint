# Release manifests

**This directory holds the contract, not the artefacts.** A release lives in the release bucket, versioned, and the
world's pointer says which one is desired ([ADR-0030](../../docs/adr/0030-desired-and-active-release.md)); the same
path on a host is the download cache `start-session.sh` reconciles from. Release 1.0's manifest was tracked here
while it was being published by hand — its S3 object and VersionId are recorded in
[docs/aws-m1-command-log.md](../../docs/aws-m1-command-log.md), which is where that provenance belongs. Nothing here
is a source of truth for a deployed release.

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

For a developer smoke test only, resolve a CurseForge source list without starting Minecraft, then build the manifest
from those exact bytes:

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

## A profile names its game

Authoring lives in one repository per game, because the contracts differ: a Minecraft profile pins a loader and
CurseForge URLs, a Factorio profile pins an engine version and exact portal versions. A profile declares its game in
a `game` field and **absence means minecraft**, so every existing profile and every release already cut from one is
unchanged. From that field, `server/scripts/_profiles.sh` derives the version field the profile uses, the loader
contract it must satisfy, the mod extension a release contains, and which resolver runs — the pinned
`mc-image-helper` container for minecraft, `server/games/factorio/resolve-mods.sh` for factorio, which needs no
container at all. The same three commands cut a Factorio release:

```bash
FACTORIO_USERNAME=... FACTORIO_TOKEN=... \
  server/scripts/resolve-profile-mods.sh \
    /path/to/my-docker-factorio-server-config/profiles/factorio-vanilla \
    /tmp/factorio-1.0/mods

server/scripts/build-profile-release.sh \
  /path/to/my-docker-factorio-server-config/profiles/factorio-vanilla \
  1.0 /tmp/factorio-1.0/mods /tmp/factorio-1.0/manifest.json
```

The manifest's `minecraft_version` carries the engine version and its `loader` repeats it, because a game that is its
own loader has no second version to record. That field name is the wart recorded in ADR-0034; renaming a published
schema costs more than the note.

The resolver delegates to the digest-pinned image's `mc-image-helper curseforge-files` command. It passes the API key
only as container environment, downloads into a sibling stage, and refuses to overwrite a previous output. The game
host later consumes uploaded hashes and bytes; it does not need a CurseForge API key or resolve moving URLs at boot.

This is not the production release path. A release starts in GitHub Actions, which assumes a narrow AWS role through
OIDC and signals the AWS workflow. An ephemeral AWS builder resolves and downloads CurseForge files, freezes their
hashes and publishes the immutable release. Neither a developer workstation nor the game host is a production builder.
The AWS builder, its Step Functions wrapper, the OIDC identity and the Action now exist in code; they remain inert until
their Terraform roots are applied and the two output ARNs are configured as GitHub repository variables. Until that
acceptance run succeeds, `scripts/cut-release.sh` remains a manual bootstrap/diagnostic tool rather than the supported
automation contract.

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
