# World catalog

`catalog.json` contains only deployment-pinned legacy worlds and maps a player-facing world ID to an exact profile source. A world owns its save, runtime data and backup
lineage; a profile owns Minecraft/loader configuration and mod authoring inputs. Several worlds may eventually use the
same profile, but two different worlds never share a runtime directory.

New worlds do not require a catalog edit in this repository. The control plane discovers presets from each game's
configuration repository. On the first Start of a preset with a ready immutable release, it writes
`worlds/<world-id>/world.json` and an initial `release.json` to the release bucket. The host projects that record into
`runtime/world-catalog.json` and creates an isolated generation at
`runtime/worlds/<world-id>/generations/<generation-id>/`. Static Minecraft directories keep their legacy layout.

Generation-aware backups encode the source generation in their immutable object name. A restored `current_generation`
points at that checksum-addressed object; on its first start the host verifies and expands it into a new generation
directory. The old directory and the closed generation entry remain untouched. An archived world keeps its record and
therefore still consumes its preset instead of reappearing as an uncreated candidate.

Purge is available only for an archived world. It permanently removes every version of the world's registry record,
release pointer and S3 backups, then leaves one small completed purge marker containing the generation IDs. Because a
stopped EC2 instance is not booted merely to delete cache, `start-session.sh` consumes those markers before preparing
a later world with the same ID and removes only the named generation directories.

The profile repository is pinned to a full Git commit. Updating that commit only makes new authoring input available;
it does not change an active release. Release manifests still pin the resolved JAR bytes by SHA-256.

Optional per-world fields, each defaulting to the behaviour that predates its axis:

| Field | Default | Meaning |
| --- | --- | --- |
| `game` | `minecraft` | Which game module runs the world ([ADR-0034](../../docs/adr/0034-per-game-adapter.md)) |
| `host` | `primary` | Which host the world runs on — topology is data |
| `connectivity` | `zerotier` | The strategy that publishes the world ([ADR-0033](../../docs/adr/0033-connectivity-as-a-strategy.md)) |
| `auth` | the game's own model | Declared override: `external` states that authentication is handled outside the game defaults, which lets a non-gating strategy publish the world |
| `profile_source` | the catalog-level `profile_source` | This world's own authoring repository and pinned commit — authoring lives one repository per game, and a pin bump for one world must not invalidate another world's prepared marker |
| `footprint` | the game module's `GAME_FOOTPRINT_*` | `{ "memory_mib", "cores" }`: what a session of this world is placed with and limited to ([ADR-0054](../../docs/adr/0054-place-a-session-on-a-host-with-room.md)) — the container's memory, not the heap, and a core weight. The panel's catalog carries the same figures, and a test keeps them equal |

The catalog validator enforces the gate-versus-auth invariant statically: a world with no authentication on a
non-gating connectivity is not a loadable catalog. An open server is always a diff someone wrote, never a default
someone forgot.

Inspect a catalog entry without changing the filesystem:

```bash
server/scripts/world-profile.sh world
server/scripts/world-profile.sh vanilla
```

Prepare the isolated runtime directory:

```bash
SPAWNPOINT_WORLDS_DIRECTORY=/srv/spawnpoint/worlds \
  server/scripts/prepare-world.sh vanilla
```

The operation writes `.spawnpoint-world.json` beside `data/` and `mods/`. Repeating it is safe. If the marker disagrees
with the requested world, profile repository or pinned commit, it fails instead of reusing the directory. Changing a
world's profile therefore requires an explicit migration rather than a catalog edit followed by an unsafe boot.
