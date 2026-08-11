# Prior art

[ADR-0003](adr/0003-build-not-reuse.md) commits to building every layer rather than deploying an existing
template. That decision only holds if the prior art is actually read first. This file records what exists,
what is worth borrowing at the level of ideas, and what is deliberately not being reused.

Nothing here is copied without attribution and a licence check. Facts about each project need verifying
against its current documentation before they are relied on — the notes below were written from a single
reading in August 2026, and these projects change.

## On-demand hosting

### `doctorray117/minecraft-ondemand`

<https://github.com/doctorray117/minecraft-ondemand>

The reference implementation of on-demand Minecraft on AWS. A CDK template that runs the server as an ECS
Fargate task with a watchdog sidecar. Waking is implicit and clever: Route 53 query logging captures the
client's failed DNS lookup, CloudWatch forwards it to a Lambda, and the Lambda scales the service to one
task. The watchdog updates the DNS record to the new task IP, optionally notifies, and scales back to zero
after a period with no connections.

**Worth borrowing**

- The implicit DNS wake, as a possible *second* trigger. It needs no button and no always-on component.
- The watchdog-writes-its-own-DNS-record pattern, which removes any need for a static address.
- Scale to zero as the default state, not an optimisation.

**Not reused**

- Fargate, and therefore EFS for the world. This project uses EC2 Spot with a local EBS volume. See
  [ADR-0004](adr/0004-ec2-spot-for-the-game-server.md).
- CDK. See [ADR-0011](adr/0011-terraform-for-infrastructure.md).
- The anonymous wake as the *only* trigger. An explicit request carries an identity, which the chat
  notifications and rate limiting both need. See [ADR-0006](adr/0006-on-demand-start-and-idle-shutdown.md).

**Constraint to remember:** its trigger Lambda must live in `us-east-1`, because Route 53 ships query logs
only to that region. If the implicit wake is ever added here, that constraint comes with it.

## The game container

### `itzg/docker-minecraft-server`

<https://github.com/itzg/docker-minecraft-server>

The de facto standard Minecraft server image. Handles version and loader selection, mod and plugin
installation, RCON, autosave, JVM tuning and graceful stop on SIGTERM, all through environment variables.

**Reused directly.** This is the one deliberate exception to building from scratch: the image solves a
packaging problem, not an architecture problem, and its graceful-stop behaviour is what the interruption
handler and the idle watchdog depend on. See [ADR-0005](adr/0005-containerised-game-server.md).

Pin an exact tag. Read its documentation for the environment variables that matter here: mod directory
handling, RCON configuration, autosave interval, and stop timeout.

## Mod pack management

### `packwiz`

<https://github.com/packwiz/packwiz>

A command-line pack manager. A pack is a set of small metadata files under version control; the tool
resolves versions from Modrinth and CurseForge and exports to both launcher formats.

**Worth borrowing**

- The core idea that a pack is a manifest, not a folder of binaries — which is the shape of
  [ADR-0008](adr/0008-versioned-mod-releases.md).
- Its export step, possibly reused rather than reimplemented. Producing `.mrpack` and CurseForge output
  correctly is fiddly, and it sits at the edge of the system rather than at its core. See
  [ADR-0013](adr/0013-modpack-distribution.md).

**Not reused as the source of truth.** The server must boot without depending on an upstream API being
available, and server-side and client-side mod sets differ.

## Server management panels

### Pterodactyl, Crafty Controller

<https://pterodactyl.io> · <https://craftycontrol.com>

Full server management panels: web UI, console access, file management, scheduled tasks, multiple servers.

**Worth borrowing**

- Their feature lists are a good checklist of what operators actually need day to day. Read them before
  designing the panel in [ADR-0012](adr/0012-web-control-panel.md), then cut ruthlessly.

**Not reused.** They are somebody else's control plane, which is the component being built here. They also
assume an always-on host, which contradicts the design.

### Kubernetes operators, for example `Shulker`

Mentioned only for completeness. Rejected with the platform in [ADR-0014](adr/0014-no-kubernetes.md).

## Still to read

- Existing Minecraft Discord bots, for the command vocabulary players already expect.
- AWS's own guidance on Spot interruption handling, to check the save-and-stop sequence against it.
- How other projects health-check a modded server start, since slow and hung look identical for the first
  few minutes. This is the weakest part of the current design. See
  [ADR-0009](adr/0009-s3-as-mod-source-of-truth.md).
