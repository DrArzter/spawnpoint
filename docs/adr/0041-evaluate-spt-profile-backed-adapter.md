# ADR-0041 — Evaluate SPT as a profile-backed adapter without distributing EFT

- Status: Proposed
- Date: 2026-09-10
- Relates: [ADR-0034](0034-per-game-adapter.md), [ADR-0040](0040-reusable-presets-and-world-wipes.md), and [ADR-0013](0013-modpack-distribution.md)

## Context

Single Player Tarkov (SPT) is a useful test of whether Spawnpoint's game model generalises beyond map-backed dedicated servers. SPT runs a local backend that emulates the services used by a modified Escape from Tarkov client; its durable gameplay state is primarily profiles and shared backend configuration rather than a map directory. Optional projects such as Fika add multiplayer, but baseline SPT is explicitly solo.

SPT's public source demonstrates a [server](https://github.com/sp-tarkov/server-csharp), launcher, modules and a [release packager](https://github.com/sp-tarkov/bento) that emits an archive plus manifest. The C# server repository includes container definitions and is therefore structurally compatible with Spawnpoint's disposable-host model. However, the core GitHub repositories were archived in August 2026, their current canonical upstream must be established, and the [SPT installer](https://forge.sp-tarkov.com/installer) still requires a legitimate, current Escape from Tarkov installation.

## Proposed decision

Treat SPT as a future **profile-backed game adapter**, not as an exception to the world model. One Spawnpoint world represents one isolated SPT backend and its profile set. A wipe creates a new clean profile lineage; backups preserve the profiles and the adapter-declared server state. The adapter, not the shared control plane, defines which paths constitute durable state and how readiness, active players and a safe stop are detected.

An SPT preset declares the SPT version, compatible EFT client version, server configuration and server/client mods. Its immutable release contains only SPT server artifacts and mods proven redistributable by the licence gate, resolved versions and hashes, and a client manifest. It must not contain or distribute proprietary EFT binaries or game assets. A player supplies a legitimate local EFT installation and applies the compatible client-side pieces through separately reviewed instructions or tooling.

Baseline support targets solo SPT. [Fika](https://forge.sp-tarkov.com/mod/2326/project-fika) or another co-op layer is a distinct adapter capability because it changes networking, session occupancy and client compatibility; installing it must not silently turn the solo contract into multiplayer.

No production adapter is accepted by this record. A feasibility spike may begin after the Factorio and Project Zomboid adapters prove the common lifecycle. It must answer these gates first:

1. Identify the maintained canonical upstream and a version source suitable for reproducible builds.
2. Prove the server can run and persist profiles correctly on the target Linux/container host.
3. Document licences and redistribution rights for every packaged SPT component and mod.
4. Prove the client compatibility and update path without handling EFT-owned files.
5. For co-op, separately prove connectivity, authentication, player detection and safe shutdown.

## Consequences if accepted

- `World` remains the shared control-plane term even when an adapter presents it to players as a server or profile realm.
- Game adapters must declare persistent state rather than assuming every game has a map save.
- Release and backup manifests need adapter-specific compatibility metadata while retaining common identities and hashes.
- Spawnpoint may automate server deployment and mod resolution, but ownership checks and client patching remain outside its trusted server artifact pipeline.
- Failure to satisfy the upstream, licence or client-boundary gates rejects the adapter without weakening the rest of the platform.

## Alternatives considered

| Option | Why not chosen |
| --- | --- |
| Treat each SPT profile as a Spawnpoint world | Couples infrastructure lifecycle to individual players and cannot naturally represent shared traders, configuration or future co-op |
| Package a ready-to-run EFT client | Crosses the proprietary-content boundary and makes Spawnpoint responsible for distributing files it does not own |
| Model SPT as a one-off service outside game adapters | Avoids testing and improving the shared abstraction, and duplicates releases, backups and lifecycle controls |
