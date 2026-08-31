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

### exaroton, Aternos — on-demand as a hosted service

<https://exaroton.com> · <https://aternos.org>

The same consumption model this project builds, offered as a service, by one company: Aternos free and queue-based,
exaroton pay-per-use — **1 credit per GB of RAM per hour at €0.01, and the server stops when nobody is online**. The
idle watchdog, shipped as a product. Recorded from their help centre 2026-08-17; verify pricing before relying on it.

Two things worth knowing from the comparison. First, validation: the demand for start-on-request, stop-when-empty
exists, and its economics work at scale. Second, calibration: at 8–16 GB their rate is roughly at parity with
on-demand EC2, so this project's cost story comes from the lifecycle itself, not from a price difference with a hosted service.

**Honest signposting, since this repository may be read by somebody choosing:** a group that wants a modded server in
minutes with no cloud account should use exaroton — it is excellent at exactly that. This project is for the operator
who wants to *own* the thing: the world and backups in their own account, infrastructure as code they can read, and
releases as first-class deployments (immutable, health-gated, rolled back by a pointer flip). Those properties matter
to the person operating the server rather than the people joining it, which is why this is a blueprint to deploy, not
a service to sign up for.

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

**A different layer of the stack, not an alternative implementation.** These panels manage *processes* on machines
that already exist and run 24/7 — a panel plus a per-node daemon — and that is the right shape for their use case:
many servers, many users, hardware you own. This project manages the *machine's* lifecycle and treats the mod set as
a deployable artefact; the overlap is roughly the start button and the backups. Choosing between them is choosing a
use case, not a winner: for a community with a dedicated box and many users, Pterodactyl is the mature answer, with
hundreds of supported games, a browser console, file management and multi-user permissions.

**Worth borrowing**

- **Eggs**: a per-game template — image, ports, environment, install steps — with hundreds of instances. This is the
  shipped prior art for the per-game adapter placeholder in [the ADR index](adr/README.md#decisions-still-to-record).
- Their feature lists as a checklist of day-to-day operator needs; read, then cut ruthlessly
  ([ADR-0012](adr/0012-web-control-panel.md)).

**Not reused.** They are somebody else's control plane, which is the component being built here for the learning's
sake, and they assume an always-on host, which contradicts the invariant in
[docs/architecture.md](architecture.md#what-runs-when-nobody-plays).

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

**`zomboid-control-panel` covers the same job list with the opposite architectural choice.** Server control, an RCON
console, a live player map, a mod manager, a scheduler, backups and a Discord bot — delivered as one always-on process
on the host, which is a perfectly reasonable shape for a machine that runs anyway. A useful contrast for seeing which
of this project's properties follow from the nothing-runs-when-nobody-plays invariant in
[docs/architecture.md](architecture.md#what-runs-when-nobody-plays) rather than from the feature list.

### How games distribute mods — five models, not two

Surveyed 2026-08-27 while mapping candidate games onto the running system. The per-game adapter's "mod strategy" axis
turned out to be an enum of five, and each model answers "what is a release?" and "does a client pack exist?"
differently:

| Model | Mechanics | Games seen | What "release" means here |
| --- | --- | --- | --- |
| **A. Manual archive** | Somebody assembles files; every client installs by hand | Minecraft (this project), Valheim (BepInEx both sides) | Immutable payload + manifest — the full M3 pipeline, packs included |
| **B. Portal-sync** | Versions exist upstream; the game client syncs the exact list from the official portal on join | Factorio ([Sync mods with server](https://forums.factorio.com/viewtopic.php?t=30745)) | Real pins, and the sync covers the common case. It is not a guarantee: a client that cannot reach the portal still needs the files, so publication builds the pack anyway — the release already holds the exact zips |
| **C. Workshop coordinated-latest** | Steam Workshop has no versions; server and clients track latest, delivery is automatic | Project Zomboid, [Don't Starve Together](https://help.akliz.net/docs/install-mods-on-a-dont-starve-together-server) (server auto-downloads via `dedicated_server_mods_setup.lua`, clients auto-get all-clients mods) | A pinned *list* of ids, not bytes; verification weakens to "ids match" honestly |
| **D. Server-push** | The server itself hands mods to connecting clients | [Vintage Story](https://wiki.vintagestory.at/Adding_mods) (full, since 1.16), [7 Days to Die](https://7d2dmodding.wiki.gg/wiki/Category:XML_Modding) (XML modlets only; asset mods stay manual), Luanti | Server payload is the release; client pack shrinks to asset-only or nothing |
| **E. Server-only plugins** | The client stays vanilla (often anti-cheat-locked); all modding is server-side | [Rust — Oxide/Carbon](https://umod.org/community/general-support/33905-client-side-modding), TShock (Terraria), SourceMod family | Pinned-release applies server-side; distribution is a non-concept |

Vintage Story deserves a footnote: its `modinfo.json` declares `Side: Universal | Server | Client` — the
client-versus-server axis built into the mod format itself, which is exactly what this project's manifest lacks (an
open question in [ADR-0013](adr/0013-modpack-distribution.md)).

### Which games could actually move in

Scored 2026-08-14 against this host's real constraints, re-scored 2026-08-27 against the running system: a headless
Linux dedicated server with a docker image, a probe for the idle watchdog (transport **and** parser — the V2 probe is
`container state + query + regex` behind a `key=value` contract), the auth model (does the game need the overlay
gate), the distribution model above, memory against the 8/16 GiB instance shapes, and cold start — paid nightly under
this lifecycle. Memory figures are community consensus, to be measured before any move, the way
[docs/measurements.md](measurements.md) measured Minecraft. Lifecycle V2, the bot, notifications, guardrails and the
backup mechanics are untouched by every game below — the game-agnostic core held.

| Tier | Game | Probe | Auth | Mods | Memory | Note |
| --- | --- | --- | --- | --- | --- | --- |
| Moves in almost free | **Factorio** | RCON built in | Own | **B** | Hundreds of MB | `factoriotools/factorio-docker` is its itzg; the resolver swaps CurseForge for the mod portal (a factorio.com token instead of `CF_API_KEY`); graftorio2 lands in the existing Grafana. **Landed as the first tenant**: a vanilla Factorio world in the catalog exercises the adapter ([ADR-0034](adr/0034-per-game-adapter.md)); the portal resolver is the next slice |
| Moves in almost free | **Terraria (TShock)** | REST | Password/whitelist | **E** | Tiny | Cheapest tenant of all |
| Moves in almost free | **Project Zomboid** | RCON (`players`, own format) | Steam, when the server runs it | **C** | 4–8 GiB | The group favourite; the one game that *bends* the release model — see the note below. **Module landed 2026-08-27**; a world needs a profile repository before it can enter the catalog |
| Moves in almost free | **Don't Starve Together** | Log/query | Klei/Steam | **C** | Tiny | Official Linux dedicated; server-side workshop auto-download is built in |
| Moves in almost free | **Vintage Story** | Own API / log | Own accounts | **D** | Modest | Official Linux dedicated (.NET); mod format carries the client/server side axis natively |
| Moves in almost free | **Rust** | WebRCON | Steam+EAC | **E** | 12+ GiB | Plugins never touch clients; wipe culture maps onto several-worlds ([ADR-0023](adr/0023-multiple-worlds.md)); world generation stretches cold start |
| With friction | **7 Days to Die** | **Telnet** — the only transport change among the three studied | Steam | **D** (XML) + **A** (assets) | 8–12 GiB | Probe needs a telnet wrapper; XML modlets push free, asset packs stay manual; Alloc's map as companion |
| With friction | **Valheim** | A2S query / log — no RCON | Steam + password | **A** | 2–4 GiB | First genuinely per-game `players` probe; BepInEx mods manual on both sides |
| With friction | **Satisfactory** | HTTPS API | Own | mostly unmodded | 8–16 GiB | Official dedicated with an HTTP health API |
| With friction | **Palworld** | REST | Steam | — | 16+ GiB floor | Notorious memory growth |
| With friction | **Barotrauma** | Own console | Steam | **C** | Tiny | Official Linux dedicated; verify the workshop sync details before relying on them |
| Wine tier | **V Rising, Enshrouded, Sons of the Forest** | varies | Steam | varies | 8–16 GiB | Windows-only dedicated servers run under Wine/Proton in community docker images — compatible with this host's shape, but every game update is a fragility event. Verify per game before promising anybody an evening |
| Does not move in | **Ark** | RCON | Steam | C | 16+ GiB | Multi-minute starts — the nightly cold start would kill the motivation the roadmap protects |
| Does not move in | **Kenshi coop, Lethal Company, Raft and most co-op indies** | — | — | — | — | No dedicated server: the "server" is a rendering, licensed, Steam-logged-in game client — the Porthole disqualification class from [ADR-0024](adr/0024-connectivity-modes.md) |

Cross-cutting, from mapping the three studied in depth (Factorio, Zomboid, 7DtD) onto the running system:

- **The probe is a transport times a parser.** RCON, telnet, A2S, REST, log tail — the transport varies; the
  `key=value` contract to the watchdog stays. The most Minecraft-coupled node is not the probe but the **profile
  resolver**, which runs itzg's `mc-image-helper` and writes `loader.type: "forge"` into every manifest — the manifest
  needs a game axis before a second tenant.
- **The backup sentinel is per-game.** `level.dat` is Minecraft's; Factorio's save is a single zip, Zomboid's a
  directory family. The world catalog is the natural home for a per-world validation marker.
- **Instance shape becomes a per-world property.** Factorio is happy below the current host; 7 Days to Die wants the
  16 GiB shape. The catalog again.

### Project Zomboid's mod model — the inverse of Minecraft's

Worth its own note because it bends the adapter's mod axis. Checked 2026-08-14; B42 multiplayer reached stable on
2026-07-29 (42.20), so the near-term risk is B42 mod-ecosystem maturity after the B41/B42 split, not hosting.

- **Minecraft**: distribution is the hard part — every client needs the exact matching JARs, which is why M3/M4
  exist. Pinning is trivial: a CurseForge file ID is immutable.
- **Zomboid**: distribution is mostly free — a joining client auto-downloads the server's Workshop items. **Pinning is
  impossible**: the Workshop has no versions, everything tracks latest. When a mod author pushes an update
  mid-evening, auto-updated clients mismatch the still-running server and some players cannot join; every guide's fix
  is "restart the server so it re-pulls".

Checked 2026-08-27, before writing the module, because both answers decide whether it can exist at all:

- **The dedicated server installs anonymously.** It is a separate Steam app (380870) and `steamcmd +login anonymous`
  is enough, so neither the server nor this project needs a Steam account. Only the players need to own the game
  ([SteamCMD guides](https://pimylifeup.com/project-zomboid-dedicated-server-linux/),
  [PZwiki](https://pzwiki.net/wiki/Dedicated_server)).
- **The server fetches its own mods.** Workshop ids listed in its configuration are downloaded at startup by the
  server itself ([Nodecraft](https://nodecraft.com/support/games/project-zomboid/how-to-download-and-enable-workshop-mods-on-your-project-zomboid-server)),
  which is why no credential wiring is needed for a modded world either.

So the release model, not the credentials, is the constraint. **A Zomboid world carries no release pointer today**:
the mod set is Workshop ids, the immutable-bytes manifest does not apply, the manifest builder refuses
`RELEASE_GAME=zomboid` on purpose, and boot-time reconciliation treats a world with no pointer as the legitimate
pre-release state it already handles.

**How the ids reach the server is the open question, and the image decided part of it.** Checked against
[`Terule/pz-dedicated-server`](https://github.com/Terule/pz-dedicated-server) on 2026-08-31: it documents fourteen
environment variables and **none** of them is a Workshop list, and none is the server name either. So a modded
Zomboid world cannot be configured by environment the way Minecraft and Factorio are — the ids belong in the server's
own ini file inside the data volume, which means somebody must render them there before the container starts. Two
shapes for that, and the choice is not obvious:

| Shape | What it buys | What it costs |
| --- | --- | --- |
| The ids live beside the world (an operator-placed file, rendered into the ini by `game_prepare_session`) | No schema change; the world is self-contained | No promotion, no rollback, no history — the mod set is whatever is on the disk |
| The ids become a release: a manifest with a `workshop` array and no files, pointer-flipped like any other | Promotion, rollback and an audit trail arrive for free, and model C's honesty is written into the manifest | Stretches "release" from bytes to ids, and a rollback is only as reproducible as the Workshop is |

The second is the better fit for a project whose release machinery already exists, and it makes the weakening
explicit rather than absent. It is not built: the first Zomboid world can be vanilla, and vanilla needs neither.

Two smaller findings from the same check, already fixed in the module: the image takes `RCON_PASSWORD` from the
environment rather than writing it into the volume the way Factorio does, and since nothing sets the server name, the
save directory's name belongs to the server — so the save sentinel looks for whatever single world lives under
`Saves/Multiplayer` instead of assuming the catalog's world id.

Two house rules apply to Zomboid, both recorded in
[server/games/README.md](../server/games/README.md) after Factorio needed them. Its auth default is `none` unless the
server this repository configures actually verifies Steam identities — a direct-connect server without Steam
authentication verifies nobody, and the connectivity invariant reads that default to decide whether the world may be
published without an overlay. And publication still builds the client pack: automatic Workshop delivery is the normal
path, not a guarantee, and the release already holds the files a client that cannot reach the Workshop would need.

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
