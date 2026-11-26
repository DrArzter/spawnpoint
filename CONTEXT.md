# Spawnpoint domain

Spawnpoint is a control plane for running one selected game world on disposable compute while preserving the world and its release history independently.

## Language

One word per thing. If a word here disagrees with a word in the product, the product is wrong.

**Game**: A server runtime family such as Minecraft or Factorio. A game may have many worlds.

**Game module**: The folder that teaches Spawnpoint one game: a manifest of its facts (`game.json`) that every layer reads, and the hooks the host calls. Platform code knows a game only through its module. _Avoid_: Game adapter when the whole folder is meant.

**Preset**: A versioned declaration from a preset source describing a reusable mod and server-configuration template. A preset is authoring input, not a world, save, preset snapshot or deployable release. One preset may produce many releases and may be used to create many worlds. _Avoid_: Pack or uploaded archive when the declaration is meant.

**Preset source**: An external authoring origin from which Spawnpoint can obtain a versioned preset snapshot. GitHub is one preset source, not part of the preset's identity. _Avoid_: Configuration repository when the source need not be Git.

**Preset snapshot**: An inert, content-verified tree materialized by a preset-source adapter for cataloging and release construction. It contains authoring input and provenance, not executable build logic or a finished release. _Avoid_: Checkout when the source need not be Git.

**Upstream modpack**: A third-party launcher archive and its matching server pack, pinned by immutable provider file identities and used as dependencies while building a preset release. Spawnpoint normalizes their bytes into a client pack, server mods and managed server overrides; the upstream modpack is neither a Preset nor a Release, and is never fetched when a world starts.

**Client pack**: The complete client-side content of a release: mods, configuration, resource packs, shader packs and every additional file supplied by the pack author. It carries the required game and loader versions for a launcher to install, but excludes a player's credentials, personal saves and local runtime caches.

**World**: A named, persistent playable instance created from a preset, with its own generations and backup history. It is what a player joins. A world exists while no host does. Several independent worlds may use the same preset. _Avoid_: Save as a noun, because it names the data and not the world. The verb stays: stopping a session saves the world. A world does not have one release for its entire lifetime; each generation carries its own release state.

**World config file**: A text file inside a game's config roots that a world keeps its own version of, written over the release's file at every start and kept across wipes. _Avoid_: Override when the release's managed files are meant.

**World log**: The game's own recent lines on the host that runs a world, read on request, with addresses, ids and player names replaced by tokens before anyone sees them. _Avoid_: Host log, which names the host's own lines of a start.

**Log assistant**: An AI model an Owner asks to explain a world log, paid for by the deployment and capped per day and per month. _Avoid_: Bot, which names the Telegram bot.

**Proposal**: A change the log assistant asked for in a conversation, which runs only when the Owner applies it. _Avoid_: Action or suggestion, which name nothing stored.

**World generation**: One save lineage in a world's history, created from a specific release and carrying its own desired and active release state. Regenerating a world closes the current generation with a recoverable final backup and starts a fresh generation from a selected release without reusing the previous save. Promoting a compatible release may update an existing generation without creating a new one. A generation may have many backups; it is not itself a backup.

**Wipe**: The player-facing name for a world generation and, by extension, the deliberate transition that closes the current generation and starts the next one. Interfaces may say “current wipe”, “wipe history” and “start new wipe”; internal records retain the precise term world generation.

**Host**: A compute machine capable of running one or more sessions at once. A host is not permanently owned by a world; a session temporarily binds one world to one host. A *configured* host is the one the deployment declares, which is stopped, never terminated; a *launched* host is created for a session and exists only while at least one session is on it or its grace period has not ended. _Avoid_: Server or instance when the domain concept, rather than the AWS resource, is meant; compute host and shared game host, which are spellings of the same machine.

**Footprint**: What one world's session needs from a host: a memory figure that becomes the container's hard limit, and a core weight that bounds how many sessions share the host's cores. Declared per world, defaulting per game. It is the unit of placement; it is not the JVM heap, which is smaller.

**Launch requirements**: What a launch asks the cloud for: the footprint beside the system reserve, as minimum memory and minimum cores, within the allowed instance families. Never an instance type and never a price; the cloud answers with the cheapest instance that meets them at that moment.

**Host shape**: What a host turned out to be — the instance type, memory and cores the cloud answered a launch with — recorded on the host. It is read, not chosen. _Avoid_: Instance type when the domain concept is meant.

**Placement**: The decision that binds a starting session to a host: reuse the ready host that would have the least room left, or launch one that meets the footprint's requirements.

**Reservation**: A session's claim on part of a host's capacity, holding a slot. Reservations are recorded on the host and released only after the session's stop has verified its archive. The slot numbers the session's ports.

**Probe port**: The port a game's player probe speaks to, on the host's loopback: RCON, a Steam query or a REST API, whichever the game offers. It is the second port of a session's slot. _Avoid_: RCON port when the game has no RCON.

**Session volume**: The EBS volume a session on a Spot host runs its world from, created for the session in its host's Availability Zone and deleted when the session stops. It survives an interruption, so a replacement host attaches it instead of restoring from S3 ([ADR-0102](docs/adr/0102-spot-for-cold-launched-hosts-with-a-session-volume.md)). _Avoid_: Data volume, which is the configured host's permanent disk.

**Moving**: The state of a session whose Spot host is being reclaimed. It keeps its id, its world and its session volume, and starts again on a new host at the same address. Nothing stops it while it moves, and the idle watchdog does not count it ([ADR-0102](docs/adr/0102-spot-for-cold-launched-hosts-with-a-session-volume.md)). _Avoid_: Migrating, restarting.

**Session address**: What a player types to reach a running session — the host part from the world's connectivity strategy, the port from the session's slot — as the host composed it when the session became ready. It is recorded on the lifecycle record for the session's lifetime and never configured. _Avoid_: Connection address as a stored setting.

**Connectivity strategy**: An independently selected adapter that makes a session reachable and supplies the host part of its address. An overlay can gate access; a public IP or DNS record cannot, so a public strategy requires declared player authentication. Host placement does not itself choose the strategy, although a disposable fleet host may support only public strategies. _Avoid_: Treating ZeroTier or DNS as an intrinsic property of a game or host.

**Host tier**: The one Prometheus and Grafana a host runs for every session on it, as its own Compose project. It finds a session's exporter by label rather than by name, and outlives any single session. _Avoid_: Session observability for a placed session.

**Drain**: The state of a host with no reservations, waiting out a grace period in which a start may still take it. A drain ends in the host being terminated, or stopped when its last tenant was a `warm` world.

**Headroom**: A deployment's paid choice to keep at least a stated amount of memory free somewhere while anything runs, so the next session lands on a host already up. Zero by default; nothing is kept when nothing runs.

**Release**: An immutable, content-verified build of one preset containing the exact server configuration and mod versions. Its canonical identity is the preset plus a version unique within that preset, such as `industrial@2.1`; a bare version is meaningful only inside an already selected preset. When built from an Upstream modpack, its managed server overrides are authoritative release content, while worlds, player data and operator-owned server files remain outside the release.

**Release candidate**: A proposed release with a fixed identity and preset snapshot that has not yet been successfully published. It is not deployable until its complete content has been verified and published.

**Build attempt**: One effort to construct and publish a release candidate. Retrying a failed attempt retains the candidate's identity and source; it does not create another release.

**Backup**: A recoverable point-in-time snapshot of one world generation, associated with the release that produced it. Restoring a backup creates a new generation from that saved state; it does not turn the backup into a world or release.

**World-owned data**: Data that a server mod or plugin writes for one world beside its save, such as the LuckPerms database in `mods/luckperms/` or a `world_data` path inside a managed config root. A backup holds it and a release change keeps it; jars and caches are not world-owned data. _Avoid_: Mod config when the files the release ships are meant.

**Desired release**: The release an open world generation is currently meant to run. It may differ from the active release while a deployment operation is in progress or has failed.

**Active release**: The last release that started for an open world generation and passed the server health check. It is evidence of a successful deployment, not merely a requested value.

**Promotion**: A deployment operation that changes an open world generation's desired release, proves it by starting and health-checking the server, and only then commits it as active. A failed promotion restores the previous desired release and attempts the same mechanism in reverse.

**Adoption**: Bringing an existing world under generation and release-pointer management by verifying its already-installed release and recording that release as both desired and active for its first managed generation. _Avoid_: “import” for this case; import creates a new managed world from external save data.

**Operation**: One durable attempt to change or observe lifecycle state, with its own identity, status and failure history. The operation is separate from the desired and active release values it may change.

**Control-plane event**: An immutable fact that Spawnpoint accepted a command or observed a lifecycle change. It records what happened; it is not a command, desired state or permission to perform another change.

**Control-plane view**: A rebuildable, eventually consistent picture of current hosts, operations and worlds for user-facing surfaces. It may inform people, but it is never authoritative enough to approve or drive a lifecycle transition. _Avoid_: Dashboard state, source of truth.

**Session**: One identified period in which a world is being started on a host, is ready for players, or is being stopped. A new start receives a new session identity so work left over from an earlier session cannot stop or modify it.

**Identity**: One person authorised to use Spawnpoint, independent of the chat, game and network accounts through which that person is recognised.

**Login session**: A revocable period in which a browser may continue acting as one previously verified external account without repeating sign-in. It is distinct from a gameplay Session. _Avoid_: Browser session, auth token.

**Agent connection**: One identity's revocable delegation to an external MCP client. The approved scopes are a ceiling on what that client may ask for; the identity's current role and permissions still decide what Spawnpoint will actually perform. The client never receives the identity's login credential. _Avoid_: Bot user, API password, or treating a scope as a role.

**Login provider**: An adapter that verifies one kind of credential and produces a provider-neutral principal for a login session. A deployment chooses which providers it offers; no provider is part of an identity's type. A login provider does not resolve identities and grants no permission. _Avoid_: Identity provider when the credential is one Spawnpoint itself keeps.

**Password credential**: A verified email address and salted password hash kept by Spawnpoint as one possible linked account. It may establish a new identity relationship or be added to an existing identity; the credential's own id, not the address, is the account's subject.

**Visitor**: A platform-authenticated person who has reached a Spawnpoint surface but has not been approved as an identity. A visitor may see only explicitly public, non-sensitive information.

**Access candidate**: A visitor whose external account has been observed and is waiting for an Owner to approve or dismiss access. It is not an identity and carries no role or operational permission.

**Access decision notification**: A transactional reply telling a visitor that their own access request was approved. It is not a subscription and does not itself grant or prove any permission.

**Role**: A named set of permissions that the owner defines as data ([ADR-0083](docs/adr/0083-panel-roles-are-owner-defined-data.md)). Every identity holds exactly one. A role changes only when its version is current, and a role that someone holds cannot be deleted.

**Built-in role**: One of the four roles every deployment starts with: viewer, player, operator and owner. A built-in role can be edited but not deleted.

**Protected role**: The Owner role. It holds every permission, including the reserved ones, and it cannot be edited or deleted. At least one active identity holds it.

**Default role**: The role a newly approved or invited person gets unless the approver picks another. The owner chooses it; it is never the protected role. Viewer until chosen.

**Permission**: One named right, such as `session.start`. The list of permissions is fixed in code, because permissions are the route gates. The API serves it as the **permission catalogue**, with a label and a sentence for each.

**Reserved permission**: A permission that only the protected role holds, such as `access.owner.grant`. No other role and no direct grant may hold one.

**No escalation**: A caller may give a role, take one away, or put a permission into a role only when the caller holds every permission involved.

**Direct grant**: A single permission added to one identity on top of its role. Direct grants only add permissions; they never remove one. An identity whose role the deployment does not know holds only its direct grants. A grant is an exception, not a class. A direct grant never carries a reserved permission, such as `access.owner.grant`: only the Owner role holds it, so the last-owner rule counts every holder.

**Bootstrap owner**: The first identity granted the built-in Owner role through a one-time trusted setup path. After it is claimed, all other identities and roles are managed through normal access control. _Avoid_: Superadmin; Owner is the privileged role, while bootstrap describes only how its first holder is established.

**Profile**: The user-facing representation of an identity, including its display details and linked accounts. It is not an authentication authority.

**Linked account**: A provider account associated with exactly one Spawnpoint identity after that provider proves its stable subject. An identity may have several linked accounts from different enabled login providers, and none is primary merely because it was used first. _Avoid_: User; one person may have several linked accounts.

**Access invitation**: A single-use invitation to join a Spawnpoint deployment with its default role. When email delivery is configured it is addressed to an email and requires proof of that mailbox; in an email-free deployment it is a one-time link redeemed after login through an enabled provider. The invitation never chooses the login provider. _Avoid_: Game invitation, provider-specific registration link.

**Subscription**: One identity's opt-in to a category of notifications, optionally scoped to a particular game. Roles do not imply subscriptions.

**Direct notification**: A targeted message to one or more existing identities about a specific reason, optionally a prompt to play a selected world. It communicates context and an action but grants no access. _Avoid_: Invitation when no right or membership is granted.

**Notification delivery**: The single claimed attempt to notify eligible recipients. Its outcome records how many targets succeeded or failed; it is not inferred from creating the notification.

**Notification delivery readiness**: A current indication that an identity has opted into a notification category and has a reachable channel. It helps a sender choose recipients, but is not a delivery guarantee; eligibility is checked again when delivery begins.

**Whitelist**: The list of Minecraft player names that a world's record keeps (ADR-0066). The host writes it to the server at every start, and a running world reloads it at once. It is per world, not per identity, and it holds names that an offline server cannot prove belong to anyone. Only the Minecraft game module uses it today. _Avoid_: Allow-list, or a derived list of linked Minecraft identities.

**World role**: _Intended, not built._ A role that an owner defines as data and attaches to a player name in one world, so that a player has rights inside the game without a Spawnpoint identity. Today a world has only the whitelist and no per-name rights. A world role is separate from the panel role that an identity holds. _Avoid_: Op level as the model; an op level would be one mechanism for it.
