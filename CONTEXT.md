# Spawnpoint domain

Spawnpoint is a control plane for running one selected game world on disposable compute while preserving the world and its release history independently.

## Language

**World**: A named, persistent game save with its own release pointer and backup lineage.

**Release**: An immutable, content-verified server configuration and mod set identified by a version.

**Desired release**: The release a world is currently meant to run. It may differ from the active release while a deployment operation is in progress or has failed.

**Active release**: The last release that started for the world and passed the server health check. It is evidence of a successful deployment, not merely a requested value.

**Promotion**: A deployment operation that changes a world's desired release, proves it by starting and health-checking the server, and only then commits it as active. A failed promotion restores the previous desired release and attempts the same mechanism in reverse.

**Adoption**: Bringing an existing world under release-pointer management by verifying its already-installed release and recording that release as both desired and active. _Avoid_: “import” for this case; import creates a new managed world from external save data.

**Operation**: One durable attempt to change or observe lifecycle state, with its own identity, status and failure history. The operation is separate from the desired and active release values it may change.

**Session**: One identified period in which a world is being started, is ready for players, or is being stopped. A new start receives a new session identity so work left over from an earlier session cannot stop or modify it.
