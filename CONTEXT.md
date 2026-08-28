# Spawnpoint domain

Spawnpoint is a control plane for running one selected game world on disposable compute while preserving the world and its release history independently.

## Language

**Game**: A server runtime family such as Minecraft or Factorio. A game may have many worlds.

**World**: A named, persistent game save with its own release pointer and backup lineage.

**Host**: A compute machine capable of running a session. A host is not permanently owned by a world; a session temporarily binds one world to one host. _Avoid_: Server or instance when the domain concept, rather than the AWS resource, is meant.

**Release**: An immutable, content-verified server configuration and mod set identified by a version.

**Desired release**: The release a world is currently meant to run. It may differ from the active release while a deployment operation is in progress or has failed.

**Active release**: The last release that started for the world and passed the server health check. It is evidence of a successful deployment, not merely a requested value.

**Promotion**: A deployment operation that changes a world's desired release, proves it by starting and health-checking the server, and only then commits it as active. A failed promotion restores the previous desired release and attempts the same mechanism in reverse.

**Adoption**: Bringing an existing world under release-pointer management by verifying its already-installed release and recording that release as both desired and active. _Avoid_: “import” for this case; import creates a new managed world from external save data.

**Operation**: One durable attempt to change or observe lifecycle state, with its own identity, status and failure history. The operation is separate from the desired and active release values it may change.

**Session**: One identified period in which a world is being started on a host, is ready for players, or is being stopped. A new start receives a new session identity so work left over from an earlier session cannot stop or modify it.

**Identity**: One person authorised to use Spawnpoint, independent of the chat, game and network accounts through which that person is recognised.

**Visitor**: A platform-authenticated person who has reached a Spawnpoint surface but has not been approved as an identity. A visitor may see only explicitly public, non-sensitive information.

**Access candidate**: A visitor whose external account has been observed and is waiting for an Owner to approve or dismiss access. It is not an identity and carries no role or operational permission.

**Role**: A named reusable set of permissions assigned to an identity. Built-in roles provide safe defaults; custom roles may be added without changing clients.

**Direct grant**: An exceptional permission attached to one identity in addition to its role. Direct grants only add permissions; a custom role is used when permissions must be removed.

**Bootstrap owner**: The first identity granted the built-in Owner role through a one-time trusted setup path. After it is claimed, all other identities and roles are managed through normal access control. _Avoid_: Superadmin; Owner is the privileged role, while bootstrap describes only how its first holder is established.

**Profile**: The user-facing representation of an identity, including its display details and linked accounts. It is not an authentication authority.

**Linked account**: An external chat, game or network identity associated with exactly one Spawnpoint identity. _Avoid_: User; one user may have several linked accounts.

**Subscription**: One identity's opt-in to a category of notifications, optionally scoped to a particular game. Roles do not imply subscriptions.

**Invitation**: A request from one identity to play a selected game world, addressed either to specific identities or to every eligible identity.
