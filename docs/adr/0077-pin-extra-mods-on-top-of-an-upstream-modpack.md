# ADR-0077 — Pin extra mods on top of an upstream modpack

- Status: Accepted — minimum version implemented
- Date: 2026-11-22
- Milestone: M6
- Amends: [ADR-0068](0068-normalize-upstream-modpacks-into-releases.md),
  [ADR-0069](0069-give-players-a-mod-set-of-their-own.md) (Scope),
  [ADR-0040](0040-reusable-presets-and-world-wipes.md) (preset composition)
- Amended by [ADR-0079](0079-pin-an-addon-to-a-github-release-asset.md): a third source, `github_release`, which
  downloads from GitHub
- Amended on 2026-11-22: an addon may declare `world_data` paths inside the managed config roots. See
  [World data](#amendment-2026-11-22-world-data)

## Context

A modpack preset (ADR-0068) runs exactly the pack the author published. The owner wants extra mods in an existing
modpack world: the worked example is Sophisticated Backpacks on Prominence II 4.1.4. Facts that shape the decision:

- The official Sophisticated Backpacks and Sophisticated Core are Forge and NeoForge only. Prominence II is Fabric.
- The only Fabric build is an unofficial port (LGPL-3.0-only), published on Modrinth only: Backpacks version
  `Jk6o7s4h` and Core version `BP3CQI2v`.
- mc-image-helper does not resolve mod dependencies; it can only report a missing one.
- ADR-0069 refuses its side lists beside a modpack, and keeps "our own mods on a modpack" as a separate decision.
- ADR-0040 keeps preset composition (add, remove, `extends`) for a later decision.

## Decision

**A modpack profile may name one more file, `mods.addons`.** It is valid only with `resolver: curseforge-modpack`.

```json
"mods": {
  "source": "extras/curseforge-modpack.json",
  "resolver": "curseforge-modpack",
  "addons": "extras/addons.json"
}
```

**Each entry pins one exact file and states its side.** `side` is `both`, `server` or `client`, set by hand.

- CurseForge: `{project_id, file_id}`. The build reads the file's SHA-1, size, game versions and the project's
  distribution setting from the API, and checks the download against them.
- Modrinth: `{project_id, version_id, file, sha512, bytes}`. The build makes the URL on the Modrinth CDN from these
  fields and checks SHA-512 and size. No other host is used for this source.
- A CurseForge file whose author switched off third-party distribution is refused. The author may give the same bytes
  as a Modrinth entry, or as `mirror: {url, sha512, bytes}` that must also match the CurseForge SHA-1 and size
  (the ADR-0068 rule).
- There is no "latest" and no slug without a file. `required_by` is for reviewers; the build does not trust it.
- `config: {tree, replaces}` is optional. `tree` is a folder in the profile with only the six managed roots
  (`config`, `defaultconfigs`, `kubejs`, `scripts`, `global_packs`, `openloader`), plus `client/` with the same roots.
  A top-level file goes to the server and to the client pack; a `client/` file goes to the client pack only.
  `replaces` names every pack file the tree overwrites (`client/…` for a client pack file). An overwrite that
  `replaces` does not name refuses the build. A name that overwrites nothing also refuses.

The sample under `docs/examples/prominence-addons/addons.json` pins the two Fabric port files.

**The build checks the addons against the pack before they enter a release** (`server/scripts/check-mod-set.sh`). It
reads `fabric.mod.json`, `quilt.mod.json`, `META-INF/mods.toml` and `META-INF/neoforge.mods.toml` from each JAR as
data, with nested JARs, and runs once on the server set (pack server JARs + `both` + `server`) and once on the client
set (pack client JARs + `both` + `client`):

| Check | Result |
| --- | --- |
| C1 Loader and Minecraft | No metadata for the profile's loader refuses. A declared Minecraft range that excludes the profile's version refuses; a range it cannot read warns. A CurseForge file not published for the version and loader refuses. |
| C2 File name | A file name the pack already has refuses, with the same or other bytes. |
| C3 CurseForge project | A project the pack's client lock already has refuses. |
| C4 Mod id | A top-level mod id (or `provides`) the pack already has refuses; two addons with one id refuse. A nested duplicate warns. |
| C5 Disabled in the pack | An addon that matches a `*.jar.disabled` file of the server pack warns. |
| C6 Required dependencies | Every required id must be in the same set, top-level or nested. Presence only; versions come later. |
| C7 Declared breaks | A `breaks` (or `incompatible`) that matches a mod in the set refuses, either way round. A version it cannot compare refuses. |
| C8 Side | A dependency that only an addon of the other side provides refuses. |

The same checks run again at every build, so a pack update that starts to ship the same mod, drops a dependency or
ships the same config file refuses the build, and the owner changes the addon entry.

**The release records the addons.**

- `server.mods` is the pack's JARs plus `both` and `server` addons. `server.overrides` is the pack config with the
  addon config over it. Hosts do not change.
- `client` stays `{kind: "curseforge-modpack", file: "client.zip", …}` and gains
  `addons: [{file, sha256, bytes, side}]`. It is deployed content, so it is part of the release identity. A `both`
  or `server` addon has the digest of its `server.mods` entry; a `client` addon is stored under `client-mods/`, so a
  download by digest works.
- The client pack is still one import. `both` and `client` addons go under its overrides `mods/`, the addon config
  under its overrides, and the pins into `spawnpoint-client-lock.json` as `addons`. Its manifest keeps `files: []`
  and its `version` becomes `<upstream>+<release>`, for example `4.1.4+1.0`.
- A new top-level `mod_index` maps the SHA-256 of every server file and client addon to its mod ids. It is
  descriptive only: the identity gate (`canonical_manifest` in `upload-release.sh`) does not include it. In this
  version only a release with addons carries it, so a release without addons is built exactly as before.
- `server.zip` and `full.zip` stay for an ADR-0069 mod set only.
- The release API answers `addons` with each file and side.

**Amendments.**

- ADR-0068: a modpack release may carry pinned addons; the client pack is then the upstream pack plus the addons.
- ADR-0069, Scope: side lists stay refused beside a modpack. A modpack uses `mods.addons`, with a side per entry,
  so one profile never mixes the two vocabularies.
- ADR-0040: adding mods to one preset through `mods.addons` is allowed. `extends` and removal stay deferred. A pure
  pack and an extended pack that must both exist are still two presets.

### Amendment 2026-11-22: world data

A server mod can keep its data inside a root that the release manages, for example `config/<mod>/data`. The
overrides swap replaces each managed root as one unit, so it deleted that data at every start.

- An addon entry with `side` `both` or `server` may list `world_data`: paths below one of the six roots, for example
  `"world_data": ["config/examplemod/data"]`. A whole root is refused. Two paths where one is inside the other are
  refused. A `client` addon may not declare `world_data`.
- The lock keeps each entry's `world_data`. The manifest carries the sorted union as `server.world_data`, inside the
  release identity. A release without `world_data` has no such key, so its identity does not change.
- The build refuses a `world_data` path that is, contains or is inside a file the release ships (pack config or addon
  config). `upload-release.sh` and `download-release.sh` check the same rules.
- `reconcile-server-overrides.sh` moves each `world_data` path from the old root into the new root, then swaps the
  roots. If the swap fails at any step, including a root that cannot move into the previous directory, every moved
  root and its data go back. If one cannot go back, the stage and the previous directories are kept, and nothing is
  deleted.
- **A path stays world data once a release declared it.** The marker `.spawnpoint-overrides.json` records the paths.
  A later release that does not declare a path still keeps it. A later release that ships a file at, inside or above
  such a path stops the start, and nothing is changed or deleted. The operator then decides (owner decision,
  2026-11-22).
- The archive holds the `world_data` paths and the marker, so a host move or a restore keeps them
  ([ADR-0010](0010-world-persistence-and-backups.md#amendment-2026-11-22-world-owned-data)).

## Consequences

**Good**

- The worked example builds: the Fabric port comes from Modrinth, pinned by SHA-512.
- A conflict fails the build, not the server start after a promotion.
- Building a release changes no world. Only a promotion or a new wipe puts the addons into a save.

**Bad, or risky**

- The Fabric port is unofficial, older than the official mod (3.23.4 against 3.26.21) and has another maintainer.
  Removing it later loses every backpack and its contents.
- C6 checks presence, not versions. A nested library with another version than the pack's shows only at boot
  (C4 warns). The server start and the automatic rollback (ADR-0030) remain the final proof.
- Forge Config API Port keeps server configs in the world's `serverconfig/`, which the release does not manage.
  A `defaultconfigs/` file reaches only a world that has no such file yet (assumption, to verify).
- Two vocabularies for sides exist: side lists for presets of CurseForge files, `addons.json` for modpacks.

**Mitigations**

- Test the addons on a disposable world first. Take the pre-promotion backup before a promotion.
- Keep each addon's licence under review. LGPL-3.0 allows redistribution on its terms (general guidance, not legal
  advice).

## Alternatives considered

| Option | Why not chosen |
| --- | --- |
| ADR-0069 side lists beside a modpack, plus a `mods.add` text list | CurseForge only, so it cannot build the example; a text list allows unpinned lines |
| `extends: <preset>` in a child preset | Cross-profile reads break the per-profile digest and catalog readiness |
| Upload JARs in the panel | No provenance; Git is the only authoring surface (ADR-0040) |
| Resolve addon dependencies automatically | Adds files nobody reviewed; mc-image-helper cannot do it either |
