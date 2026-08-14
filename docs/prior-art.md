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

- Fargate, and therefore EFS for the world. This project uses one EC2 instance with a local EBS volume. See
  [ADR-0032](adr/0032-on-demand-single-instance.md).
- CDK. See [ADR-0011](adr/0011-terraform-for-infrastructure.md).
- The anonymous wake as the *only* trigger. An explicit request carries an identity, which the chat
  notifications and rate limiting both need. See [ADR-0006](adr/0006-on-demand-start-and-idle-shutdown.md).

**Constraint to remember:** its trigger Lambda must live in `us-east-1`, because Route 53 ships query logs
only to that region. If the implicit wake is ever added here, that constraint comes with it.

### mc-router, Infrared, lazymc — wake-on-connect, implemented three times

<https://github.com/itzg/mc-router> · <https://github.com/haveachin/infrared> · <https://github.com/timvisee/lazymc>

Found 2026-08-14. [ADR-0006](adr/0006-on-demand-start-and-idle-shutdown.md) declined "a proxy holding the player's
connection while the server boots — the nicest possible wake" as needing an always-on process. That alternative is not
hypothetical: it exists at least three times over. `mc-router` — by **itzg, the author of this project's server image**
— routes clients by the hostname in the Minecraft handshake, and when the target container is stopped it starts it,
holding the client with a loading MOTD. Infrared calls the same thing "autostart when pinged" plus an "idle
placeholder"; lazymc sleeps a local server and wakes it on connect.

**Worth borrowing**

- The framing: this project's start workflow is a *distributed lazymc* — the same sleep-and-wake behaviour with the
  always-on process replaced by Step Functions, so that nothing runs when nobody plays.
- If measured cold-start friction ever demands the implicit wake, the answer is a known project on a tiny always-on
  host, not something to design from scratch.

**Not reused**

- All three are resident processes, which is exactly the invariant in
  [docs/architecture.md](architecture.md#what-runs-when-nobody-plays). The decline in ADR-0006 stands; it now points at
  named projects instead of a hypothesis.

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

## Across other games — routing and companions

Surveyed 2026-08-14, prompted by the per-game adapter placeholder in [the ADR index](adr/README.md#decisions-still-to-record)
and the strategy interface in [ADR-0033](adr/0033-connectivity-as-a-strategy.md). Two questions: can several games
share one address, and what web companions would ride on a session.

### Name-based routing exists exactly where the protocol carries a name

- **Minecraft**: the handshake carries the requested hostname, so a whole proxy ecosystem exists — the wake-on-connect
  trio above, plus gameplay-level proxies (Velocity, BungeeCord).
- **Terraria**: TCP with a rich server API. `Dimensions` (<https://github.com/popstarfreas/Dimensions>) is a routing
  and load-balancing proxy over TShock; players teleport between backing servers through it.
- **Factorio, Project Zomboid, Valheim, Rust and the rest of the Steam-UDP family**: impossible by protocol, not by
  neglect. The client resolves the domain itself and sends UDP to an address — the name never reaches the server, so
  there is nothing to route on (<https://forums.factorio.com/viewtopic.php?t=42878>). Several servers on one host means
  one port each.

**Consequence for the adapter:** "can share one address" is a per-game property, like the auth model in
[ADR-0033](adr/0033-connectivity-as-a-strategy.md) — TCP-with-a-name games can consolidate; UDP games take a port each
and the connection string simply includes it.

### Web companions — the live map is nearly universal

What the second host-side HTTP service — the one that justifies the session proxy in
[ADR-0033](adr/0033-connectivity-as-a-strategy.md) — would actually be, per game:

| Game | Companion | Note |
| --- | --- | --- |
| Minecraft | BlueMap, Dynmap, squaremap; Plan for player analytics | The richest ecosystem, as usual |
| 7 Days to Die | Alloc's Server Fixes web map, with CSMM built on its API | Semi-official; a map plus a server web API out of one mod |
| Valheim | `valheim-webmap` (<https://github.com/h0tw1r3/valheim-webmap>) | Server-side only BepInEx mod: browser map, pins from chat, players need nothing |
| Project Zomboid | `zomboid-control-panel` (<https://github.com/fpsacha/zomboid-control-panel>) | See below — much more than a map |
| Terraria | Map-snapshot plugins; TShock's REST API (<https://tshock.readme.io/reference/rest-api-endpoints>) | The API is the interesting part: server control over HTTP |
| Factorio | **`graftorio2`** (<https://github.com/remijouannet/graftorio2>) | No map; the ecosystem went to metrics instead — a mod exporting factory statistics to Prometheus for Grafana |

Two of these matter beyond the list:

**`graftorio2` slots into this project without a single new component.** The session already runs Prometheus and
Grafana per [ADR-0015](adr/0015-observability-and-alerting.md); a Factorio session would add one scrape target and one
dashboard to the same stack. That is the strongest confirmation yet that the per-game adapter's "companions" axis is
real and reusable, not speculation.

**`zomboid-control-panel` is this project built as a monolith.** Server control, an RCON console, a live player map, a
mod manager, a scheduler, backups and a Discord bot — the same job list as this control plane, delivered as one
always-on process on the host. Read it as the control experiment: what the same requirements produce without the
nothing-runs-when-nobody-plays invariant in [docs/architecture.md](architecture.md#what-runs-when-nobody-plays).

### Which games could actually move in

Scored 2026-08-14 against this host's real constraints: a headless Linux dedicated server with a docker image, a
player-count probe for the idle watchdog, the auth model (does the game need the overlay gate), memory against the
8/16 GiB instance shapes, and cold start — paid nightly under this lifecycle. Memory figures are community consensus,
to be measured before any move, the way [docs/measurements.md](measurements.md) measured Minecraft.

| Tier | Game | Why |
| --- | --- | --- |
| Moves in almost free | **Factorio** | Official headless server, RCON built in, `factoriotools/factorio-docker` is its itzg. Hundreds of MB, instant start. The mod portal has a real API, so the M3 pipeline maps almost 1:1, and graftorio2 lands in the existing Grafana |
| Moves in almost free | **Terraria (TShock)** | Tiny, TCP, REST for health and players, whitelist and password. Cheapest tenant of all |
| Moves in almost free | **Project Zomboid** | Official dedicated server, RCON, and the Workshop distributes mods to clients by itself. 4–8 GiB with mods — the group favourite; see the mod-model note below |
| Moves in almost free | **7 Days to Die** | Official Linux dedicated, telnet admin, Alloc's map as the companion. 8–12 GiB asks for the 16 GiB shape |
| With friction | **Valheim** | Dedicated and docker exist, but no RCON — the player probe becomes A2S query or a log tail, the first genuinely per-game `players.sh` |
| With friction | **Satisfactory** | Official dedicated with an HTTPS API for health; 8–16 GiB |
| With friction | **Rust** | Dedicated and RCON exist, but 12+ GiB, world generation makes cold start minutes long, and wipe culture wants the several-worlds model of [ADR-0023](adr/0023-multiple-worlds.md) |
| With friction | **Palworld** | Dedicated and REST exist; notorious memory growth makes 16 GiB a floor, not a ceiling |
| Does not move in | **Ark** | 16+ GiB and multi-minute starts — the nightly cold start would kill the motivation the roadmap protects |
| Does not move in | **Kenshi coop, Lethal Company, Raft and most co-op indies** | No dedicated server: the "server" is a rendering, licensed, Steam-logged-in game client — the Porthole disqualification class from [ADR-0024](adr/0024-connectivity-modes.md) |

### Project Zomboid's mod model — the inverse of Minecraft's

Worth its own note because it bends the adapter's mod axis. Checked 2026-08-14; B42 multiplayer reached stable on
2026-07-29 (42.20), so the near-term risk is B42 mod-ecosystem maturity after the B41/B42 split, not hosting.

- **Minecraft**: distribution is the hard part — every client needs the exact matching JARs, which is why M3/M4
  exist. Pinning is trivial: a CurseForge file ID is immutable.
- **Zomboid**: distribution is free — a joining client auto-downloads the server's Workshop items. **Pinning is
  impossible**: the Workshop has no versions, everything tracks latest. When a mod author pushes an update
  mid-evening, auto-updated clients mismatch the still-running server and some players cannot join; every guide's fix
  is "restart the server so it re-pulls".

Two consequences for this project:

1. **The on-demand lifecycle is accidentally an anti-drift mechanism.** An always-on Zomboid server drifts from the
   Workshop for days; this one restarts every session by design and re-pulls on each boot, shrinking the mismatch
   window to updates that land mid-session. The remaining sliver is the coordination skeleton of
   [ADR-0028](adr/0028-update-proposals.md) with the pin step removed: detect the upstream update, announce to chat,
   restart at the next pause.
2. **The adapter's mod axis has two legitimate strategies, not a boolean**: *pinned-release* (CurseForge, this
   project's M3) and *coordinated-latest* (Workshop). Forcing Workshop games into pinned releases means hand-copying
   mod versions onto the server, which kills the free client distribution — a bad trade for a six-person group. A
   removed map mod still corrupts a save, so the preview-on-a-copy idea in
   [ADR-0029](adr/0029-preview-environments.md) and the backup discipline transfer unchanged.

## Prior art that is not about Minecraft at all

The release pipeline was arrived at from the problem rather than copied, and it landed on a shape that already has
names. Worth recording, because borrowed vocabulary is clearer than invented vocabulary, and because these tools have
solved the parts still open here.

### Spacelift, Atlantis, Terraform Cloud — plan, approve, apply

<https://spacelift.io> · <https://runatlantis.io>

Infrastructure orchestration platforms. A push to version control triggers a run; the run produces a **plan** — a diff
of desired against actual; a human **approves** it; the platform **applies** it atomically and records the outcome; and
it periodically checks for **drift** between the real world and the declared state.

That is [ADR-0028](adr/0028-update-proposals.md) exactly, with a mod set in place of infrastructure. The same four
words are the right ones to use for it: plan, approve, apply, drift.

**Worth borrowing:** their **policy-as-code** idea, adopted below. Also their run history as an audit surface, and
their stack dependencies, which are what this design calls groups of mods that must move together.

**Not reused:** the platforms themselves — twice over. For mods, they orchestrate IaC tools against IaC state, and
mods are neither; see the "Not Terraform" section of [ADR-0028](adr/0028-update-proposals.md). And for their native
job, this project's own Terraform: one operator applying four small roots a few times a month has none of the problems
they sell answers to (multi-user RBAC, policy gates, drift dashboards) — and any such SaaS holds apply-rights
credentials to the AWS account, a third party with write access that this project keeps declining. The real remaining
need, plan-on-pull-request and a scheduled drift check, is the "CI for infrastructure" placeholder in
[the ADR index](adr/README.md#decisions-still-to-record): GitHub Actions assuming a role through OIDC, the same
thin-client mechanism as ADR-0028. Reconsider only if this ever becomes a multi-operator service.

### Renovate and Dependabot — where the proposal comes from

<https://docs.renovatebot.com> · <https://docs.github.com/code-security/dependabot>

Dependency updaters. They watch upstream for newer versions, group related packages, open a proposal with a changelog,
and let the maintainer decide. The grouping and the "one pull request per family" behaviour are the same problem as
111 CurseForge projects with interdependent families.

So this design is really **Renovate's proposal, Spacelift's gate, and a deployment on the end** — which is a more
honest description than anything invented for it, and a better one to say out loud.

**Worth borrowing:** grouping rules, and the idea that some updates are boring enough to merge without review.

**Not reused:** neither understands mod-loader compatibility or CurseForge metadata, which is the whole resolution step.

### npm and its lockfile — declaration against artefact

The relationship between the mod list and a release is a manifest and a lockfile: the list says *which*, the release
says *which exact files with which hashes*. That framing is why the list stays a file in git rather than moving into
the panel. See [ADR-0028](adr/0028-update-proposals.md).

## Still to read

- Existing Minecraft Discord bots, for the command vocabulary players already expect.
- AWS's own guidance on Spot interruption handling, to check the save-and-stop sequence against it.
- How other projects health-check a modded server start, since slow and hung look identical for the first
  few minutes. This is the weakest part of the current design. See
  [ADR-0009](adr/0009-s3-as-mod-source-of-truth.md).
