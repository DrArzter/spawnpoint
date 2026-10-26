# ADR-0069 — Give a preset's players a mod set of their own

- Status: Accepted
- Date: 2026-10-26
- Milestone: M6
- Relates: [ADR-0013](0013-modpack-distribution.md) (answers its open question on server-side mods),
  [ADR-0040](0040-reusable-presets-and-world-wipes.md), [ADR-0065](0065-hand-out-world-files-as-short-lived-links.md),
  [ADR-0068](0068-normalize-upstream-modpacks-into-releases.md)

## Context

A preset of CurseForge files had one mod list. The server ran it and the client pack was a copy of it. Players
therefore installed server tools they do not need (a profiler, a backup mod), and the preset had nowhere to put mods
only players need (a minimap, shaders). ADR-0013 left open whether server-side mods are excluded from the pack
automatically or marked by hand. Mod metadata does not say reliably which side a mod is for.

## Decision

**A profile may name two more lists beside `mods.source`, in the same format, resolved the same way:**

```json
"mods": { "source": "mods.txt", "server_only": "server-only.txt", "client_only": "client-only.txt" }
```

- `source`: mods both sides install, as before.
- `server_only`: mods only the server runs.
- `client_only`: mods only players install.

The server runs `source` + `server_only`. Players install `source` + `client_only`. Each list is resolved on its own,
because the resolver does not report which list entry became which file; a side list therefore never has to name a
mod by its file name. A dependency a side list shares with `source` (the same name and bytes) is kept once; the same
name with other bytes refuses the build, and so does a side list that adds nothing.

**The release records both sets.** `server.mods` stays the server's set, so hosts change nothing. A new client kind,
`client: {kind: "mod-set", mods: [...]}`, lists every file players install with its SHA-256. A file both sets carry is
stored once, under `mods/`; a players-only file is stored under `client-mods/`. The client pack is built from the
players' set. The release API answers it as `clientMods`; the panel marks each mod "Server and players", "Server only"
or "Players only", and a mod of either set can be downloaded by its digest.

**Scope.** Side lists are accepted only for Minecraft presets of individual CurseForge files. A CurseForge modpack
already brings the author's client pack (ADR-0068); adding our own mods to it is a separate decision. Factorio clients
take their mods from the server.

## Consequences

- A preset without side lists builds exactly the release it built before, byte for byte, so existing releases and
  their immutability check are unchanged.
- Marking sides is a manual, reviewed edit in Git, like every other part of a preset (ADR-0040). This is the add and
  remove composition ADR-0040 deferred, limited to the two sides of one preset.
- A players-only mod is as public as the client pack it ships in: `release.read` may download it, as it may the pack.
- Players still replace their mods folder wholesale (ADR-0013), so a mod moving between lists needs nothing more
  from them than a new pack.

## Alternatives

| Option | Why not |
| --- | --- |
| Read the side from mod metadata | CurseForge and mod loaders do not record it reliably; a wrong guess breaks either the server or a player |
| One `players` list that removes and adds relative to `source` | A removal must name a resolved file, and the resolver does not map list entries to files |
| Edit the sides in the panel | Git is the only authoring surface (ADR-0040); a panel edit has no review and breaks reproducible releases |
