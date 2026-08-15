# World catalog

`catalog.json` maps a player-facing world ID to an exact profile source. A world owns its save, runtime data and backup
lineage; a profile owns Minecraft/loader configuration and mod authoring inputs. Several worlds may eventually use the
same profile, but two different worlds never share a runtime directory.

The profile repository is pinned to a full Git commit. Updating that commit only makes new authoring input available;
it does not change an active release. Release manifests still pin the resolved JAR bytes by SHA-256.

Inspect a catalog entry without changing the filesystem:

```bash
server/scripts/world-profile.sh main
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
