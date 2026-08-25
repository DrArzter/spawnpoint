# server

What runs on the game instance: the container definition, and the scripts the automation invokes there.

Contents:

- `compose.yaml` — the game server, using [`itzg/docker-minecraft-server`](https://github.com/itzg/docker-minecraft-server),
  with an exact image tag. Never `latest`. See [ADR-0005](../docs/adr/0005-containerised-game-server.md).
- `user-data.sh` — idempotent first-boot setup for the disposable host: install Docker, a digest-verified pinned
  Compose plugin, and verify SSM. It deliberately does not guess a disk, clone a moving Git branch, handle secrets or
  start the stack.
- `scripts/` — invoked by SSM Run Command, not by a human:
  - `prepare-data-volume.sh` — verify an explicitly named block device, optionally format only an empty one, and mount
    it by filesystem UUID,
  - `configure-zerotier.sh` — bind ZeroTier state to the mounted data volume before its first start, then join one
    validated network ID,
  - `start.sh` — idempotently start the Compose service and wait for Docker health or RCON readiness,
  - `status.sh` — report container health and verify the Minecraft control path through RCON,
  - `players.sh` — report a machine-readable player count; an unparseable response fails closed,
  - `check-session-activity.sh` — expose the fail-closed player activity contract used by the future idle watchdog,
  - `idle-probe.sh` — the watchdog's exit-code contract over `players.sh`: 0 empty, 3 occupied, anything else a probe
    failure. The workflow reads the code, never the output,
  - `save-world.sh` — disable autosave, run `save-all flush`, and re-enable autosave even on failure,
  - `stop.sh` — save first, then let Compose perform the graceful container stop,
  - `archive-world.sh` — archive a stopped live world with Zstandard, write SHA-256 and verify the result,
  - `verify-archive.sh` — verify checksum, safe paths, archive readability and the presence of `level.dat`,
  - `upload-world-backup.sh` — idempotently upload a content-addressed archive and verify its S3 checksum, metadata
    digest and size,
  - `download-world-backup.sh` — download only into a new temporary file, verify both S3 and local SHA-256, then make
    the archive visible for restore,
  - `restore-world.sh` — restore only into a new or empty non-live data directory,
  - `read-release-pointer.sh` — read a world's desired/active release pointer (ADR-0030); exit 3 means "not imported
    yet", which callers treat as a state, not an error,
  - `download-release.sh` — ensure a complete verified local copy of a release; a cache on the data volume, so an
    unchanged boot downloads nothing and a tampered entry is refetched,
  - `resolve-mod-list.sh` — fetch a pinned mod list (`slug:fileId`, ADR-0028) from CurseForge into a payload
    directory; SHA-1 and size verified against the API's own record, cache heals itself, an author-disabled
    download fails with instructions. `server/tests/fake-curl` stands in for the API under test,
  - `build-release-manifest.sh` — create an immutable SHA-256 manifest for an exact mod payload,
  - `resolve-profile-mods.sh` — developer-only resolver smoke test; production resolution belongs in the AWS release
    builder triggered by GitHub Actions,
  - `world-profile.sh` — resolve a required world ID to its pinned authoring profile and isolated runtime paths,
  - `prepare-world.sh` — idempotently create or verify a marker-bound world/data/mods directory,
  - `upload-release.sh` — publish a release to the release bucket: mods first, manifest last, so a partial upload never
    looks complete. Re-publishing an identical release is idempotent; identity ignores descriptive fields
    (`created_at`, changelog) per [releases/README.md](releases/README.md),
  - `reconcile-release.sh` — verify and atomically replace the mod directory with that exact payload.
- `observability/` — provisioned Prometheus configuration and Grafana session dashboard. `mc-monitor`, cAdvisor and
  node_exporter are declared beside Minecraft in Compose and share its lifetime.

Planned later: fetch the desired release from S3, and invoke backup/retention from orchestration. The Spot interruption
notice is handled only if [ADR-0027](../docs/adr/0027-spot-request-shape.md) is un-deferred; the server runs on-demand
today.

The world, the mod directory and the configs are mounted from the persistent EBS volume. Nothing that matters
is inside the image or on the root volume. See [ADR-0010](../docs/adr/0010-world-persistence-and-backups.md).

Every script here must be safe to run twice. The automation retries.

## Local operator slice

Copy `.env.example` to `.env`, supply both secrets, and make sure `extras/cf-mods.txt` exists. The scripts resolve the
Compose project relative to their own location, so they can be called from any working directory:

```bash
server/scripts/start.sh
server/scripts/status.sh
server/scripts/players.sh
server/scripts/save-world.sh
server/scripts/stop.sh
```

`start.sh` starts the whole Compose project, including session observability. `stop.sh` saves Minecraft first and then
stops the whole project, so Grafana cannot accidentally become always-on compute. Prometheus and Grafana keep local
Docker volumes across an ordinary Compose stop; losing that history with a disposable instance is intentional.

Prometheus remains host-local at `http://127.0.0.1:9090`. Grafana also defaults to loopback, but has its own bind
setting so an overlay deployment can expose only the dashboard without exposing Prometheus:

```bash
GRAFANA_BIND_ADDRESS=0.0.0.0
```

M0 uses this form, so Grafana follows the host's persistent ZeroTier identity even if its managed overlay address is
changed and needs no local SSM tunnel. This is safe only while the EC2 security group keeps its zero-inbound-rule
invariant: port 3000 must not be added there. Anyone admitted to the ZeroTier network can reach the login page.

The initial dashboard shows Minecraft health, players and response time, Minecraft-container CPU/RAM, and host
memory/disk. It does not yet show MSPT or JVM heap/GC; those need a JVM or game-aware exporter.

Outputs use `key=value` lines. Human-readable diagnostics go to stderr, and a non-zero exit means the requested state
was not reached. This is intentionally also the future SSM contract: Step Functions sends one script, examines the
exit code, and routes failure through `Retry` or `Catch` without duplicating the host logic.

`check-session-activity.sh` is narrower than the human-facing status commands. Exit `0` means RCON returned a valid
player count and reports `activity=idle|active` plus `players_online`. Exit `2` reports `activity=unknown` when the
container is not running, RCON is unavailable, or its response cannot be parsed. It never prints the raw RCON response
or player names. Therefore only `exit=0` together with `activity=idle` is evidence an idle watchdog may count; an
unknown reading must not become an empty reading by accident.

By default the scripts manage `server/compose.yaml`, not any Minecraft Compose project that happens to be running on
the same Docker daemon. During migration from an existing setup, point them at that project explicitly:

```bash
SERVER_PROJECT_DIRECTORY=/path/to/existing/project \
SERVER_COMPOSE_FILE=/path/to/existing/project/docker-compose.yml \
server/scripts/status.sh
```

Run `status.sh` first and check its `compose_file`, `compose_service` and container state before invoking `stop.sh`.
The scripts fail if Compose cannot resolve required environment variables; that failure must never be reported as
`already_stopped`.

`start.sh` defaults to a ten-minute timeout and a five-second poll. They can be changed for a measured pack:

```bash
START_TIMEOUT_SECONDS=300 START_POLL_SECONDS=5 server/scripts/start.sh
```

After stopping, exercise the complete local backup and restore path:

```bash
server/scripts/archive-world.sh
server/scripts/verify-archive.sh server/backups/world-<timestamp>.tar.zst
server/scripts/restore-world.sh server/backups/world-<timestamp>.tar.zst /tmp/spawnpoint-restore-test
```

The checksum sits beside the archive as `.sha256` and is mandatory during verification. `restore-world.sh` refuses
the live `server/data` path and any non-empty target. To test the mechanism without the real world, set
`SERVER_DATA_DIR` and `SERVER_BACKUP_DIR` to disposable fixture directories.

Upload only a previously verified archive. The key includes its SHA-256, so an automation retry verifies the existing
object instead of writing another copy. The host role deliberately has no `s3:DeleteObject`: exact `5/2/2` pruning is
control-plane responsibility, not a permission given to the game server.

```bash
BACKUP_BUCKET=<bucket> AWS_REGION=eu-central-1 \
  server/scripts/upload-world-backup.sh server/backups/world-<timestamp>.tar.zst

BACKUP_BUCKET=<bucket> AWS_REGION=eu-central-1 \
  server/scripts/download-world-backup.sh \
    worlds/world/archives/world-<timestamp>-<sha256>.tar.zst \
    /tmp/world-from-s3.tar.zst
```

Set `AWS_PROFILE=spawnpoint` for a human local run. On EC2 omit it and use the instance role. `S3_ENDPOINT_URL` is the
only adapter switch needed for a LocalStack-compatible endpoint; production code does not branch on environment.
`server/tests/backup-s3-test.sh` exercises upload, retry, download and a deliberately corrupt metadata failure without
network or AWS credentials.

Additional tests guard the paths that protect the world and session. `session-activity-test.sh` covers zero players,
active players without leaking names, malformed RCON output, RCON failure and a stopped container. An error is always
unknown, never idle. `release-reconcile-test.sh` covers the release pipeline:
manifest immutability and schema, and that reconciliation refuses a tampered payload, duplicate entries, a wrong
loader, a mis-named target and a concurrent run — leaving the live mod directory untouched and no stage or backup
litter behind. `world-restore-test.sh` covers the backup contract: a byte-identical restore, refusal of the live data
directory and of a non-empty destination, and verify-archive rejecting a missing or wrong checksum, a truncated
archive with a fresh checksum, an archive without `level.dat`, and a path-traversal entry.

The tests split by environment. `compose-bindings-test.sh` renders configuration with the real `docker compose`, so it
runs on the host. The other four need a GNU userland (`realpath -m`, `stat --format`, `mapfile`, `flock`), so on macOS
they run in a container:

```bash
docker run --rm -v "$PWD:/repo:ro" alpine:3.20 sh -c '
  apk add -q bash coreutils findutils diffutils tar zstd jq util-linux openssl >/dev/null
  for t in backup-s3-test compose-files-test profile-release-test profile-resolver-test release-reconcile-test session-activity-test world-catalog-test world-restore-test; do
    bash /repo/server/tests/$t.sh || exit 1
  done'
```

A boot test also needs the exact release that belongs to the world. `REMOVE_OLD_MODS=true` means reconcile the mod
directory to the configured desired list; if that list is absent, all copied JARs are removed. This happened during
the first real restore drill and correctly made Forge reject the modded dimensions. The retry with the matching 111
mods reached Docker `healthy`, answered over RCON and shut down cleanly. Until release reconciliation exists, use a
copy of the known-good mod directory for an isolated smoke test and set `REMOVE_OLD_MODS=false` there.

**LAN presence must be declared, not inherited.** In the overlay connectivity mode the server can appear in players'
"LAN" list with no address typed, which is the nicest thing about that mode. Neither a vanilla Java dedicated server
nor the `itzg` image broadcasts that — the image contains no LAN discovery code at all — so it comes from a mod. That
mod belongs in the release manifest as a required entry, not in a pack by luck, or it disappears the first time the
pack changes and nobody knows why. See [ADR-0024](../docs/adr/0024-connectivity-modes.md) and
[ADR-0008](../docs/adr/0008-versioned-mod-releases.md).

The same Compose file should run locally, so a mod set can be smoke-tested before it reaches the server.

The manual M0 migration additionally uses `compose.m0.yaml`. Its restored mod directory has already been counted and
hashed, so the override disables CurseForge resolution during the first AWS boot. This avoids needing to copy the
owner's API key and prevents a moving upstream list from mutating the exact 111-JAR payload being tested:

```bash
docker compose -f compose.yaml -f compose.m0.yaml up -d mc
```

The first AWS boot additionally used `FORGE_FORCE_REINSTALL=true` because the secret-free migration intentionally
excluded the locally cached Forge runtime libraries. It was removed from the override immediately after that boot
reached `healthy`; leaving it enabled would turn a repair into work repeated on every session.

M1 and later use the equivalent, deliberately named `compose.release.yaml` after release reconciliation. The M2
workflow invokes `scripts/start-session.sh`, which first requires the configured ZeroTier network and address to be
present, then delegates to the ordinary lifecycle script with both Compose files:

```bash
SERVER_COMPOSE_FILES="$PWD/compose.yaml:$PWD/compose.release.yaml" scripts/start.sh
```

`SERVER_COMPOSE_FILE` remains supported for an existing single-file project. Multiple files use a colon-separated
`SERVER_COMPOSE_FILES`; the wrapper normalises every path before calling Docker Compose.

**Status:** local lifecycle, S3 backup/restore, release reconciliation, the base instance bootstrap and the first
real-EC2 acceptance test exist. S3 transfer has passed a real upload/download/byte-identical restore drill; automated
orchestration remains.
