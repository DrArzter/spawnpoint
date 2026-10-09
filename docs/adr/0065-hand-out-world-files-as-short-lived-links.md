# ADR-0065 — Hand out a world's archives and its release's mods as short-lived links

- Status: Accepted
- Date: 2026-10-09
- Milestone: M6
- Relates: [ADR-0013](0013-modpack-distribution.md), [ADR-0040](0040-reusable-presets-and-world-wipes.md),
  [ADR-0052](0052-keep-a-release-while-a-generation-names-it.md)

## Context

The owner asked for file access as a hosted server panel gives it: see the world's files, its mods and its
configuration, and take them away. Spawnpoint keeps none of that on a host the panel can reach. A fleet host is
destroyed after its session. What lasts is in S3: each verified backup is one `tar.zst` archive of the save, and each
release holds its mods and a manifest of their names, sizes and SHA-256 digests.

Until now the access API could list backups and could not read one. The comment beside the inventory said so on
purpose: a backup is the whole save, with every player's inventory and position.

A file browser into an archive would have to read and decompress about 400 MB inside a request that must answer in ten
seconds. A per-file index would show names that cannot be downloaded one by one.

## Decision

**A release's server mods are listed from its manifest and downloaded one by one.** The Releases tab of a world shows
the mods of the release its next start uses. `GET /games/{gameId}/presets/{presetId}/releases/{version}/mods/{sha256}`
(permission `release.read`) finds the file by its digest in the manifest and answers a link valid for fifteen minutes.
The digest names the file, so a mod's name, whatever characters it has, never goes into a path. The API role already
read releases to presign packs; nothing new is granted.

**A backup archive is downloaded whole, by a new permission, `backup.download`.** Only the Owner role holds it, and an
Owner can grant it to anyone. `POST /games/{gameId}/worlds/{worldId}/backups/download` checks that the key is one of that
world's archives, records who asked for which archive under `DOWNLOAD#<worldId>` in the access table for a year, and
then answers a link valid for five minutes. The API role may read `worlds/*/archives/*.tar.zst` in the backup bucket
and nothing else there.

**A browser opens the link once.** It is never stored, and the panel opens it in a new tab during the click, so it is
not taken for a pop-up.

## Consequences

- The panel shows a world's mods and gives its whole save to the people allowed to have it. Settings are ADR-0064's.
- A link can be passed on while it is valid. Five minutes and the download record bound that.
- `server.properties`, mod configuration in `config/` and other generated files are not in any archive, so they cannot
  be downloaded. The settings Spawnpoint manages are shown on the world page instead.
- Single files from inside an archive are not offered. Restore into a new wipe, or download the archive.
- MCP clients get both downloads (amended 2026-10-09): `get_release` and `get_release_mod_link` under `release.read`,
  and `get_backup_download_link` under `backup.download`, recorded like a download from the panel. All three are
  reads under the `spawnpoint.read` scope; the permission, not the scope, decides who may take a save.

## Alternatives

| Option | Why not |
| --- | --- |
| Browse an archive's files in the panel | Reading 400 MB of `tar.zst` does not fit a ten-second request, and its files still could not be downloaded one by one |
| Write a file index beside each backup | It shows names nobody can download, and costs every backup an extra object |
| Let `backup.read` download as well | Listing which backups exist and taking every player's save are different trusts |
| Proxy the bytes through the API | The Lambda would stream hundreds of megabytes; a presigned link costs the API nothing |
