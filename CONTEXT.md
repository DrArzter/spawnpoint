# Spawnpoint domain

Spawnpoint is a control plane for running one selected game world on disposable compute while preserving the world and its release history independently.

## Language

**Game**: A server runtime family such as Minecraft or Factorio. A game may have many worlds.

**Preset**: A versioned declaration from a preset source describing a reusable mod and server-configuration template. A preset is authoring input, not a world, save, preset snapshot or deployable release. One preset may produce many releases and may be used to create many worlds. _Avoid_: Pack or uploaded archive when the declaration is meant.

**Preset source**: An external authoring origin from which Spawnpoint can obtain a versioned preset snapshot. GitHub is one preset source, not part of the preset's identity. _Avoid_: Configuration repository when the source need not be Git.

**Preset snapshot**: An inert, content-verified tree materialized by a preset-source adapter for cataloging and release construction. It contains authoring input and provenance, not executable build logic or a finished release. _Avoid_: Checkout when the source need not be Git.

**World**: A named, persistent playable instance created from a preset, with its own generations and backup history. Several independent worlds may use the same preset. A world does not have one release for its entire lifetime; each generation carries its own release state.

**World generation**: One save lineage in a world's history, created from a specific release and carrying its own desired and active release state. Regenerating a world closes the current generation with a recoverable final backup and starts a fresh generation from a selected release without reusing the previous save. Promoting a compatible release may update an existing generation without creating a new one. A generation may have many backups; it is not itself a backup.

**Wipe**: The player-facing name for a world generation and, by extension, the deliberate transition that closes the current generation and starts the next one. Interfaces may say “current wipe”, “wipe history” and “start new wipe”; internal records retain the precise term world generation.

**Host**: A compute machine capable of running one or more sessions at once. A host is not permanently owned by a world; a session temporarily binds one world to one host. A *configured* host is the one the deployment declares, whose volume holds the legacy worlds and which is stopped, never terminated; a *launched* host is created for a session and exists only while at least one session is on it or its grace period has not ended. _Avoid_: Server or instance when the domain concept, rather than the AWS resource, is meant.

**Footprint**: What one world's session needs from a host: a memory figure that becomes the container's hard limit, and a core weight that bounds how many sessions share the host's cores. Declared per world, defaulting per game. It is the unit of placement; it is not the JVM heap, which is smaller.

**Launch requirements**: What a launch asks the cloud for: the footprint beside the system reserve, as minimum memory and minimum cores, within the allowed instance families. Never an instance type and never a price; the cloud answers with the cheapest instance that meets them at that moment.

**Host shape**: What a host turned out to be — the instance type, memory and cores the cloud answered a launch with — recorded on the host. It is read, not chosen. _Avoid_: Instance type when the domain concept is meant.

**Placement**: The decision that binds a starting session to a host: reuse the ready host that would have the least room left, or launch one that meets the footprint's requirements.

**Reservation**: A session's claim on part of a host's capacity, holding a slot. Reservations are recorded on the host and released only after the session's stop has verified its archive. The slot numbers the session's ports.

**Session address**: What a player types to reach a running session — the host part from the world's connectivity strategy, the port from the session's slot — as the host composed it when the session became ready. It is recorded on the lifecycle record for the session's lifetime and never configured. _Avoid_: Connection address as a stored setting.

**Host tier**: The one Prometheus and Grafana a host runs for every session on it, as its own Compose project. It finds a session's exporter by label rather than by name, and outlives any single session. _Avoid_: Session observability for a placed session.

**Drain**: The state of a host with no reservations, waiting out a grace period in which a start may still take it. A drain ends in the host being terminated, or stopped when its last tenant was a `warm` world.

**Headroom**: A deployment's paid choice to keep at least a stated amount of memory free somewhere while anything runs, so the next session lands on a host already up. Zero by default; nothing is kept when nothing runs.

**Release**: An immutable, content-verified build of one preset containing the exact server configuration and mod versions. Its canonical identity is the preset plus a version unique within that preset, such as `industrial@2.1`; a bare version is meaningful only inside an already selected preset.

**Backup**: A recoverable point-in-time snapshot of one world generation, associated with the release that produced it. Restoring a backup creates a new generation from that saved state; it does not turn the backup into a world or release.

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

**Login provider**: An adapter that verifies one kind of credential and produces a provider-neutral principal for a login session. A deployment chooses which providers it offers; no provider is part of an identity's type. A login provider does not resolve identities and grants no permission. _Avoid_: Identity provider when the credential is one Spawnpoint itself keeps.

**Password credential**: A verified email address and salted password hash kept by Spawnpoint as one possible linked account. It may establish a new identity relationship or be added to an existing identity; the credential's own id, not the address, is the account's subject.

**Visitor**: A platform-authenticated person who has reached a Spawnpoint surface but has not been approved as an identity. A visitor may see only explicitly public, non-sensitive information.

**Access candidate**: A visitor whose external account has been observed and is waiting for an Owner to approve or dismiss access. It is not an identity and carries no role or operational permission.

**Access decision notification**: A transactional reply telling a visitor that their own access request was approved. It is not a subscription and does not itself grant or prove any permission.

**Role**: A named reusable set of permissions assigned to an identity. Built-in roles provide safe defaults; custom roles may be added without changing clients.

**Direct grant**: An exceptional permission attached to one identity in addition to its role. Direct grants only add permissions; a custom role is used when permissions must be removed.

**Bootstrap owner**: The first identity granted the built-in Owner role through a one-time trusted setup path. After it is claimed, all other identities and roles are managed through normal access control. _Avoid_: Superadmin; Owner is the privileged role, while bootstrap describes only how its first holder is established.

**Profile**: The user-facing representation of an identity, including its display details and linked accounts. It is not an authentication authority.

**Linked account**: A provider account associated with exactly one Spawnpoint identity after that provider proves its stable subject. An identity may have several linked accounts from different enabled login providers, and none is primary merely because it was used first. _Avoid_: User; one person may have several linked accounts.

**Access invitation**: A single-use invitation to join one Spawnpoint deployment by creating an identity with its default role. It is independent of the login provider the recipient chooses. _Avoid_: Game invitation, registration link.

**Subscription**: One identity's opt-in to a category of notifications, optionally scoped to a particular game. Roles do not imply subscriptions.

**Direct notification**: A targeted message to one or more existing identities about a specific reason, optionally a prompt to play a selected world. It communicates context and an action but grants no access. _Avoid_: Invitation when no right or membership is granted.

**Notification delivery**: The single claimed attempt to notify eligible recipients. Its outcome records how many targets succeeded or failed; it is not inferred from creating the notification.

**Notification delivery readiness**: A current indication that an identity has opted into a notification category and has a reachable channel. It helps a sender choose recipients, but is not a delivery guarantee; eligibility is checked again when delivery begins.
