# server

What runs on the game instance: the container definition, and the scripts the automation invokes there.

Contents, once populated:

- `compose.yaml` — the game server, using [`itzg/docker-minecraft-server`](https://github.com/itzg/docker-minecraft-server),
  with an exact image tag. Never `latest`. See [ADR-0005](../docs/adr/0005-containerised-game-server.md).
- `user-data.sh` — first-boot setup: mount the data volume, install Docker, start the stack.
- `scripts/` — invoked by SSM Run Command, not by a human:
  - reconcile the mod directory against the live release, and verify hashes,
  - save the world and confirm the save completed,
  - archive the world to S3 and verify the archive,
  - report player count and health,
  - handle the Spot interruption notice: save, stop cleanly, announce.

The world, the mod directory and the configs are mounted from the persistent EBS volume. Nothing that matters
is inside the image or on the root volume. See [ADR-0010](../docs/adr/0010-world-persistence-and-backups.md).

Every script here must be safe to run twice. The automation retries.

**LAN presence must be declared, not inherited.** In the overlay connectivity mode the server can appear in players'
"LAN" list with no address typed, which is the nicest thing about that mode. A vanilla Java dedicated server does not
broadcast that, so whatever does it — an image option, or a mod in the pack — is pinned here explicitly and noted in
the Compose file. Otherwise it disappears the first time the pack changes and nobody knows why. See
[ADR-0024](../docs/adr/0024-connectivity-modes.md).

The same Compose file should run locally, so a mod set can be smoke-tested before it reaches the server.

**Status:** empty. Populated in M0, then rebuilt properly in M1.
