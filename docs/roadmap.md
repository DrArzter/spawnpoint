# Roadmap

From M1 onward, each control-plane slice gets three levels of evidence: fast unit tests, an opt-in complete local
operation, and a small real-AWS acceptance test for semantics an emulator cannot prove. The local operation uses the
same ASL, Lambda code, Terraform modules and host scripts through the adapters defined in
[ADR-0031](adr/0031-first-class-local-control-plane.md).

Six milestones. Each one ends with something that works, and each one has a definition of done that can be
answered yes or no. No milestone is "refactor" or "improve".

The order puts a playable server first, on purpose. Motivation is the scarce resource in a project built in
evenings, and a server the group is already using survives a slow week far better than a half-finished
Terraform configuration.

## Session zero — one evening, locally, before any of this

**Do not start with AWS.** Almost every number the later milestones need is unknown, and every one of them can be
measured on a laptop for nothing. Starting in the console means guessing an instance size, a volume size and a
region, then discovering all three were wrong.

So: run the intended pack locally with the `itzg` image, put the group on the overlay, and play one evening.

That single evening closes open questions in five ADRs — instance size, volume size, ARM compatibility, the
connectivity mode, and whether the cold-start assumption is anywhere near right. It also costs nothing, and it gives
the group something to play this week, which matters more for finishing this project than any architecture decision
in here.

What to capture: [docs/measurements.md](measurements.md). Fill the blanks, then M0 becomes arithmetic instead of
guesswork.

## M0 — A playable server, built by hand

**Goal:** friends can play tonight. Also: learn what the AWS resources actually are, by creating them
individually and seeing what each one needs.

- Instance launched by hand: **on-demand `m7i-flex.large`** in `eu-central-1`, the largest suitable shape allowed by
  the account's Free Plan. See
  [ADR-0032](adr/0032-on-demand-single-instance.md).
- Separate data volume, attached and mounted.
- `itzg/docker-minecraft-server` running the intended pack, via Compose.
- Security group has no inbound rules. No game port, SSH port or key pair; SSM access works through the instance's
  outbound connection.
- `online-mode=false`, `white-list=true`, `enforce-whitelist=true`, with the names added by hand. The whitelist
  becomes generated in M4. See [ADR-0022](adr/0022-minecraft-account-as-linked-identity.md).
- Connectivity mode C: the persistent ZeroTier identity lives on the data volume, and the node is admitted by hand.
  The game is reachable only over the overlay. See [ADR-0024](adr/0024-connectivity-modes.md).
- Stable ZeroTier address posted in chat by hand. Started and stopped by hand.
- Backups: a manual copy to S3 before anything risky.

- **Record milliseconds per tick under real load**, with everybody on. Under about 50 ms is healthy. Record it — do
  not gate on it. See [ADR-0032](adr/0032-on-demand-single-instance.md).

**Done when:** four people have played a full evening, and the server has been stopped and restarted with the world
intact.

**Explicitly throwaway.** Nothing from M0 survives M1. Record the region decision, the instance type, the
measured cold start and the memory headroom, because those become inputs to every later milestone.

## M1 — Rebuilt in Terraform, with backups that restore

**Goal:** the environment is reproducible, and the world is safe.

- S3 backend for Terraform state, with versioning and locking. Bootstrap steps written in the runbook.
- Persistent backup/release buckets have a separate state from disposable compute, so an ordinary host teardown cannot
  include the backups it is meant to preserve.
- Everything from M0 recreated in Terraform: VPC, subnet, gateway, route table, security group, instance,
  volume, IAM roles, buckets.
- M0's manual resources deleted, and the deletion verified in the console.
- Backup automation: world archived to S3, archive verified after upload.
- **A restore drill.** Destroy the volume deliberately, restore from an archive, and record how long it took.
- Budgets alarm in place.
- Keep the eligible `m7i-flex.large` while Free Plan credits last. Maintain an independent local world copy because
  the plan's automatic account closure is a deletion timer. Switch to Paid before expiry, before retiring that external
  copy, or before selecting the reviewed 16 GiB `r8i-flex.large`. See [docs/costs.md](costs.md).

**Done when:** `terraform destroy` followed by `terraform apply` produces a working server, and a world has
been restored from an S3 archive at least once.

The restore drill is the point of this milestone. An untested backup is not a backup, and this is the
milestone where that is cheap to discover.

## M2 — On demand

**Goal:** nobody pays for idle time, and nobody needs AWS access to start the server.

- Start operation: Lambda starts the instance, waits for health, reports state.
- Automate the existing mode C connectivity contract: wait for ZeroTier membership and verify the overlay address
  before reporting ready. Offline mode needs that network gate. See [ADR-0024](adr/0024-connectivity-modes.md).
- Idle watchdog: player count read on a schedule, save and stop after N empty readings.
- Spot interruption handler: save, clean stop, and an announcement.
- A minimal trigger — a single authenticated endpoint or a script — is enough. The panel comes in M4.
- Running-hours alarm, so a failed stop is noticed in hours rather than at the end of the month.

**Done when:** a full session runs start to finish without console access, the instance stops itself
afterwards, and a forced Spot interruption is survived with the world intact.

**Status 2026-09-12: done, except the Spot items, which are deferred with
[ADR-0032](adr/0032-on-demand-single-instance.md).** Start, idle stop and the running-hours alarm were accepted on
2026-08-26; session control was re-based on Lifecycle V2 on 2026-09-11 — fenced sessions, one watchdog per session
([docs/lifecycle-v2-rollout.md](lifecycle-v2-rollout.md)).

**Measure and record the cold start.** [ADR-0006](adr/0006-on-demand-start-and-idle-shutdown.md) assumes one
to three minutes is tolerable. If it is not, revisit before building the surfaces on top.

## M3 — Releases and the deployment pipeline

**Goal:** a mod change is a deployment, not an errand.

- Release format defined and documented. See [ADR-0008](adr/0008-versioned-mod-releases.md).
- Release store laid out in S3, with versioning on, plus separate desired and active release state.
- `scripts/` command that cuts a release from a working set of mods.
- Promotion pipeline in Step Functions Standard: validate, write desired, announce, save, stop, reconcile, start,
  health check, commit active.
- Automatic rollback on a failed start.
- Boot-time reconciliation, so a promotion while stopped lands at the next start.
- Drift detection: hashes verified after every sync, and a mismatch reported.
- **Release 1.0 by hand first**: resolve the 111 CurseForge URLs once, record file identifiers and hashes, cache the
  binaries. Only then automate the recurring check as proposals. See [ADR-0028](adr/0028-update-proposals.md).

**Done when:** a mod is added and deployed without touching the server directly, and a deliberately broken
release rolls itself back without help.

- Preview environment per proposal: throwaway instance, copy of the newest world backup, health plus log scan, result
  and a connection link in the pull request, torn down on merge or timeout. See
  [ADR-0029](adr/0029-preview-environments.md).

The health check is the hard part of this milestone, not the file syncing. See
[ADR-0009](adr/0009-s3-as-mod-source-of-truth.md).

**Status 2026-09-13: in progress.** Releases are built in AWS from Git presets and stored per preset
([ADR-0042](adr/0042-preset-scoped-release-identity.md)); promotion on Lifecycle V2 round-tripped in production on
2026-09-11. A deliberately incomplete release `9.99` rolled itself back to `1.1` without operator repair on
2026-09-13, satisfying the rollback acceptance criterion. The proposals of [ADR-0028](adr/0028-update-proposals.md)
and the previews of [ADR-0029](adr/0029-preview-environments.md) are not started.

## M4 — One bot, one allow-list

**Goal:** the people who play can start the server and get the pack, without the owner.

**Deliberately cut down.** An earlier version of this milestone had a web panel, a Cognito identity broker, three-way
account linking, magic-link sign-in from chat, and two bot platforms. That was more build effort than everything else in
this roadmap combined, and most of it is web authentication plumbing — the least differentiated thing in the design and
the easiest to learn anywhere else. It is deferred below, not deleted.

- **One** bot. Telegram, unless the group prefers Discord — not both.
- `start`, `status`, `pack`. Nothing else.
- Authorisation is a list of platform user IDs in Parameter Store. The owner edits it by hand. Five names.
- Notifications on the same bot: start requested, ready, stopped, release promoted, backup failed.
- The client pack published at a stable public URL. A file, not a site.

**Done when:** a player who has never seen the AWS console can start the server from their phone and install the current
pack.

That is an afternoon or two, against several weeks for the version that was designed. The ADRs for the larger version
stay in the repository as proposals, because the reasoning in them is sound and the analysis was the point — they are
just not on the critical path.

**Status 2026-09-12: the larger version was built after all, by a shorter route.** The Telegram bot, the Mini App and
browser panel, Telegram-only sign-in ([ADR-0037](adr/0037-telegram-only-browser-identity.md)), Owner approval with
roles ([ADR-0036](adr/0036-observed-visitors-and-owner-approved-access.md)) and notification subscriptions are
deployed; authorisation is the DynamoDB access directory, not a Parameter Store list. A client pack rides with every
release. Not built: Discord, the self-serve link code of ADR-0019, the derived whitelist of ADR-0022, the pack site of
ADR-0013.

**2026-09-17: email and password is the default way in**, with Telegram as the alternative button; the same form
registers and signs in, and approval still decides what an account may do
([ADR-0055](adr/0055-sign-in-with-email-and-password-by-default.md)). Password reset waits for a sender
([ADR-0020](adr/0020-email-channel.md)).

## M5 — Observability and guardrails

**Goal:** problems announce themselves, and the bill holds no surprises.

- The signals in [ADR-0015](adr/0015-observability-and-alerting.md), collected.
- Alarms wired to the event bus, so they reach the same chat channels.
- An SNS email subscription as the out-of-band path, so the Budgets alarm arrives even when the system that
  would otherwise deliver it is broken. See [ADR-0020](adr/0020-email-channel.md).
- Each alarm tested once by forcing its condition, and the test recorded.
- Log retention set, and custom metrics kept to the short list.
- Cost dashboard, or a monthly Cost Explorer routine in the runbook.
- Cost model updated with real figures, replacing the placeholders in [docs/costs.md](costs.md).

**Done when:** every alarm has fired at least once in a test, and one month of real cost data has been
compared against the model.

## M6 — Several worlds

**Goal:** vanilla-plus, techno, magic and techno-magic all exist, and the group starts whichever it wants.

- The world becomes a first-class entity: release line, save directory and backup lineage per world. See
  [ADR-0023](adr/0023-multiple-worlds.md).
- Every path and operation gains a required world parameter. Never defaulted — an operation with no world fails.
- Mod binaries become content-addressed, so four packs share their common libraries once.
- Reconciliation refuses to apply a release to the wrong world's directory. Cheap check, prevents the worst
  outcome in the whole system.
- `start <world>` on every surface; the panel lists worlds with status, live version and last played.
- A client pack published per world per version.

**Done when:** two worlds exist, the group switches between them without the owner touching anything, and each has
its own independent release history and backups.

This is deliberately last. Every mechanism it needs — immutable releases, pointers, reconciliation, per-lineage
backups — is built by M3, so M6 adds a dimension rather than new machinery. Doing it earlier would mean building
that dimension into machinery that does not exist yet.

**Status 2026-09-12: in progress, by a different route than planned.** Worlds are created from reusable Git presets,
each with its own wipes and backups ([ADR-0040](adr/0040-reusable-presets-and-world-wipes.md)); the Factorio and
Project Zomboid adapters exist ([ADR-0034](adr/0034-per-game-adapter.md)); the panel starts any world while the bot
operates one configured world. Content-addressed mod storage is not done.

## Afterwards, if the project earns it

Not committed to. Recorded so they are not confused with the plan. The first four are the M4 material that was cut, in
the order they would be worth adding.

- ~~Web control panel, with Cognito and Google sign-in.~~ Built, with Telegram instead of Cognito. See [ADR-0012](adr/0012-web-control-panel.md), [ADR-0037](adr/0037-telegram-only-browser-identity.md).
- Account linking by one-time code, once there is a panel identity to link to. See [ADR-0019](adr/0019-account-linking.md).
- ~~Sign-in to the panel from a linked chat account.~~ Built as Telegram sign-in; ADR-0021 is superseded by [ADR-0037](adr/0037-telegram-only-browser-identity.md).
- The second chat platform, and a whitelist derived from the link table. See [ADR-0016](adr/0016-chat-integrations.md), [ADR-0022](adr/0022-minecraft-account-as-linked-identity.md).
- A proper pack site with changelogs and version history. See [ADR-0013](adr/0013-modpack-distribution.md).

- ~~`terraform plan` in CI, with OIDC and no long-lived keys.~~ Done 2026-09-12, and further: production is deployed from reviewed pull requests. See [ADR-0043](adr/0043-deploy-production-from-reviewed-pull-requests.md).
- Minecraft whitelist derived from the link table, rather than maintained twice. See
  [ADR-0019](adr/0019-account-linking.md).
- SES, if email sign-in or a branded sender is ever wanted. See [ADR-0020](adr/0020-email-channel.md).
- A test-a-release-before-promoting stage, on a throwaway instance.
- A rendered world map, published alongside the pack.
- Implicit DNS wake as a second start trigger, if the cold start proves too visible.
- Several worlds on one host, placed by footprint, with hosts that drain and terminate when the last session leaves.
  See [ADR-0054](adr/0054-place-a-session-on-a-host-with-room.md) and
  [docs/capacity-allocation-rollout.md](capacity-allocation-rollout.md).

## Working notes

- Commit as the work happens, not in one dump at the end. The history is part of what this repository is
  for.
- Write or update the ADR in the same commit as the change it describes. An ADR written a month later is a
  reconstruction, and it shows.
- At the end of each milestone: review the ADR index for stale statuses, update the open questions, and
  record anything measured — cold start, world size, real cost.
