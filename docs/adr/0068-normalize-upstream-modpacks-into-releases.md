# ADR-0068 — Normalize upstream modpacks into releases

- Status: Accepted
- Date: 2026-10-18
- Amends: [ADR-0008](0008-versioned-mod-releases.md), [ADR-0047](0047-normalize-preset-sources-before-building.md)

A preset may depend on a CurseForge modpack, but the game host must still consume only a Spawnpoint release. The preset therefore pins the main CurseForge file and its matching server-pack file; the release builder verifies their API relationship, size and hash, keeps the original main archive as the client pack, and normalizes the server archive into JARs plus an allow-listed configuration overlay. It never selects `latest`, executes archive-provided scripts, or contacts CurseForge while a world starts.

The release owns only deterministic pack configuration roots (`config`, `defaultconfigs`, `kubejs`, `scripts`, `global_packs`, and `openloader`). Reconciliation replaces those roots as a verified unit and leaves saves, `server.properties`, operator lists and every other world-owned path untouched. This preserves the immutable-release and recoverable-world boundaries while allowing Fabric, Forge, NeoForge, Quilt and vanilla presets to share the same lifecycle.
