# ADR-0068 — Normalize upstream modpacks into releases

- Status: Accepted
- Date: 2026-10-18
- Amends: [ADR-0008](0008-versioned-mod-releases.md), [ADR-0047](0047-normalize-preset-sources-before-building.md)

A preset may depend on a CurseForge modpack, but the game host must still consume only a Spawnpoint release. The preset therefore pins the main CurseForge file and its matching server-pack file; the release builder verifies their API relationship, size and hash, materializes the complete client pack, and normalizes the server archive into JARs plus an allow-listed configuration overlay. It never selects `latest`, executes archive-provided scripts, or contacts CurseForge while a world starts.

The client pack is a CurseForge import archive whose overrides contain every indexed client dependency and every author-supplied override, including resource packs, shader packs, datapacks and arbitrary additional folders. Its manifest retains the pinned game and loader while clearing the now-embedded file references, so a compatible launcher does not resolve the mod list again. The original manifest and the SHA-256 of each resolved dependency remain in a provenance lock. Author overrides take precedence over indexed downloads, matching the launcher import order. Minecraft binaries, platform libraries and authentication stay with the player's launcher; the overrides directory is the complete pack-specific game directory, not a copy of somebody's installed Minecraft account.

Some authors disable standalone CurseForge API downloads while distributing the same files on another official host. A preset may pin an additional author archive by HTTPS URL, SHA-512 and size. An embedded file or a Modrinth index download from that pinned archive may supply bytes only when they also match the original CurseForge file's SHA-1 and size. Every dependency must resolve before publication; an incomplete client pack is a failed release.

The release owns only deterministic pack configuration roots (`config`, `defaultconfigs`, `kubejs`, `scripts`, `global_packs`, and `openloader`). Reconciliation replaces those roots as a verified unit and leaves saves, `server.properties`, operator lists and every other world-owned path untouched. This preserves the immutable-release and recoverable-world boundaries while allowing Fabric, Forge, NeoForge, Quilt and vanilla presets to share the same lifecycle.
