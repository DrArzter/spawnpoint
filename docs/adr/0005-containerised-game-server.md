# ADR-0005 — Run the game server in a container

- Status: Accepted
- Date: 2026-08-11
- Milestone: M0

## Context

The server needs a specific Java version, a mod loader (Forge, NeoForge or Fabric), a mod set, a heap
size, and a set of config files. Installing that straight onto the host makes the instance a snowflake:
the working configuration exists only on that disk, and rebuilding it after an interruption or an AMI
change is manual work.

The mod release pipeline also needs to restart only the game process, without rebooting the instance.
See [ADR-0009](0009-s3-as-mod-source-of-truth.md).

## Decision

Run the game server as a Docker container on the instance, declared by a Compose file in `server/`.
Use a maintained community image — [`itzg/docker-minecraft-server`](https://github.com/itzg/docker-minecraft-server),
published as `itzg/minecraft-server` — rather than a hand-written Dockerfile, until a requirement appears that
it cannot meet.

Mount the world, the mod directory and the configs from the persistent EBS volume, never from the image.

Building the image itself is not where the learning is. The lifecycle, the pipeline and the control
plane are, and those are all built from scratch. See [ADR-0003](0003-build-not-reuse.md).

## Consequences

**Good**

- Java version, loader version and heap size are declared in a file under version control.
- A clean, fast game restart without touching the host, which the mod pipeline depends on.
- The same container runs locally, so a mod set can be smoke-tested before it reaches the server.
- The image already handles version pinning, RCON, autosave and graceful stop on SIGTERM — all of which
  the interruption handler and the idle watchdog rely on.

**Bad, or risky**

- A dependency on a third-party image, whose environment variables become part of the configuration
  surface.
- One more layer to debug when the server fails to start.
- Image updates can change behaviour if the tag is not pinned.

**Mitigations**

- Pin the image to an exact tag, never `latest`. Update deliberately, and record the version in the runbook.
- Keep all container configuration in the Compose file, so the setup is reproducible from this
  repository alone.
- If the image ever blocks a requirement, replacing it means writing a Dockerfile. Nothing around it
  changes.

## Alternatives considered

| Option | Why not chosen |
| --- | --- |
| Plain systemd service on the host | Fewer moving parts, but the configuration lives on a disk that is easy to lose, and local testing is harder |
| Own Dockerfile from scratch | Full control, but re-solves problems the community image already handles well, with no learning that this project needs |
| Baked AMI with the server preinstalled | Fast boot, but a new AMI build for every mod change. Far too slow a loop for an evolving mod set |
| Kubernetes | Rejected outright. See [ADR-0014](0014-no-kubernetes.md) |
