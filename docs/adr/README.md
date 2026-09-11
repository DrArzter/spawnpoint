# Architecture decision records

One file per decision. Numbered, and immutable once accepted: to change a decision, write a new ADR and mark
the old one **Superseded by ADR-XXXX**. Never rewrite history in place.

Format and rationale: [ADR-0001](0001-record-architecture-decisions.md).
Template: [0000-template.md](0000-template.md).

## Measurements do not live in ADRs

Learned the expensive way from [ADR-0004](0004-ec2-spot-for-the-game-server.md), which took eight rounds of edits
before it had to be superseded. The rule above protected its *decision* and said nothing about everything else, so
every new number — the instance price, the memory reading, the settled architecture — landed in its open questions
until the file could no longer be read as a decision at all.

So: **an ADR records what was decided and why. It cites the numbers, it does not carry them.** The numbers belong in
[docs/measurements.md](../measurements.md), [docs/costs.md](../costs.md) and [docs/runbook.md](../runbook.md), which
are allowed to change without anybody's permission.

Two signs an ADR is going stale rather than being maintained: an *Open questions* section longer than the decision,
and a warning banner explaining that the title is no longer true. Both mean it is time to supersede it.

**Close a record when the decision is made.** A `Proposed` ADR is legitimately editable, which is why a decision left
at `Proposed` after it is already being built on keeps attracting revisions — [ADR-0024](0024-connectivity-modes.md)
collected eleven before it was accepted.

## Start here — most of this is not blocking

Thirty-four records is a wall, and a wall is not a plan. Read the two or three that cover what you are building now.

| To do this | You need |
| --- | --- |
| ~~Session zero and M0~~ | **Done.** [docs/aws-m0-command-log.md](../aws-m0-command-log.md) records what was actually run |
| ~~M1~~ | **Done.** [0011](0011-terraform-for-infrastructure.md), [0010](0010-world-persistence-and-backups.md), [0007](0007-ssm-instead-of-ssh.md) |
| **M2** — finish on-demand: idle watchdog, running-hours alarm | [0006](0006-on-demand-start-and-idle-shutdown.md), [0025](0025-step-functions-for-long-operations.md), [0032](0032-on-demand-single-instance.md) |
| M3 — releases and the pipeline | [0008](0008-versioned-mod-releases.md), [0030](0030-desired-and-active-release.md), then [0028](0028-update-proposals.md) and [0029](0029-preview-environments.md) |
| Everything else | Later. Read when the milestone arrives |

M0 was built on **mode C**, not the mode A this table used to name: the security group ended up with no inbound rules
at all, and the game is reachable only inside the overlay. Better than planned, and worth recording as the thing that
changed rather than quietly correcting.

**Freeze lifted** on 2026-08-12, when `server/compose.yaml` landed. The rule it leaves behind stands: a decision is
written down when it is about to be implemented, not instead of implementing it. See
[ADR-0001](0001-record-architecture-decisions.md).

## Status values

| Status | Meaning |
| --- | --- |
| Proposed | Written down, not yet committed to. Open questions remain |
| Accepted | Decided. Implementation may still be pending |
| Superseded | Replaced by a later ADR, kept for the record |
| Rejected | Considered and turned down. Kept because the reasoning is useful |

## Index

| ADR | Title | Status | Milestone |
| --- | --- | --- | --- |
| [0001](0001-record-architecture-decisions.md) | Record architecture decisions | Accepted | — |
| [0002](0002-host-on-aws.md) | Host on AWS | Accepted | M0 |
| [0003](0003-build-not-reuse.md) | Build from scratch, rather than reuse an on-demand template | Accepted | — |
| [0004](0004-ec2-spot-for-the-game-server.md) | Run the game server on EC2 Spot | **Superseded** by [0032](0032-on-demand-single-instance.md) | M0 |
| [0005](0005-containerised-game-server.md) | Run the game server in a container | Accepted | M0 |
| [0006](0006-on-demand-start-and-idle-shutdown.md) | Start on demand, stop when idle | Accepted | M2 |
| [0007](0007-ssm-instead-of-ssh.md) | Manage the instance with SSM, not SSH | Accepted | M1 |
| [0008](0008-versioned-mod-releases.md) | A mod set is an immutable, versioned release | Accepted | M3 |
| [0009](0009-s3-as-mod-source-of-truth.md) | S3 holds releases; promotion drives the deployment | Superseded by [0030](0030-desired-and-active-release.md) | M3 |
| [0010](0010-world-persistence-and-backups.md) | World on persistent EBS, backups to S3 | Accepted | M1 |
| [0011](0011-terraform-for-infrastructure.md) | Manage the infrastructure with Terraform | Accepted | M1 |
| [0012](0012-web-control-panel.md) | One control-plane API; the panel is one client | **Accepted** — implemented | M4 |
| [0013](0013-modpack-distribution.md) | Distribute the client pack from S3 and CloudFront | Proposed | M4 |
| [0014](0014-no-kubernetes.md) | Do not use Kubernetes | Accepted | — |
| [0015](0015-observability-and-alerting.md) | Session Grafana/Prometheus; CloudWatch signals and durable alarms | Accepted | M5 |
| [0016](0016-chat-integrations.md) | Discord and Telegram as control and notification surfaces | Proposed — Telegram deployed, Discord untried | M4 |
| [0017](0017-stable-server-address.md) | Stable hostname in Route 53, not an Elastic IP | Superseded by [0024](0024-connectivity-modes.md) | M2 |
| [0018](0018-identity-and-sign-in.md) | Cognito broker; panel sign-in with Google | Superseded by [0037](0037-telegram-only-browser-identity.md) | M4 |
| [0019](0019-account-linking.md) | Link chat accounts with a one-time code | Proposed | M4 |
| [0020](0020-email-channel.md) | SNS email for alerts; SES deferred | Accepted | M5 |
| [0021](0021-sign-in-from-linked-chat-account.md) | Chat sign-in, but only into an already linked account | Superseded by [0037](0037-telegram-only-browser-identity.md) | M4 |
| [0022](0022-minecraft-account-as-linked-identity.md) | Minecraft account is a linked identity; whitelist derived; `online-mode=false` | Proposed | M4 |
| [0023](0023-multiple-worlds.md) | Several worlds, one active at a time | Accepted | M6 |
| [0024](0024-connectivity-modes.md) | Connectivity is pluggable: raw address, DNS, or overlay | Accepted — **ZeroTier** | M2 |
| [0025](0025-step-functions-for-long-operations.md) | Step Functions for long operations; Lambda for the rest | Accepted | M2 |
| [0026](0026-tiered-backups.md) | Tiered backups: incremental snapshots, infrequent archives | **Rejected** on measurement; kept for its threshold | M1 |
| [0027](0027-spot-request-shape.md) | Diversified Spot fleet per session; stop-on-interruption | **Deferred** — on-demand first | later |
| [0028](0028-update-proposals.md) | Mod updates as proposals: resolve, diff, approve, promote | Proposed | M3 |
| [0029](0029-preview-environments.md) | Every proposal is tested in a throwaway preview environment | Proposed | M3 |
| [0030](0030-desired-and-active-release.md) | Separate desired release from confirmed active release | Accepted | M3 |
| [0031](0031-first-class-local-control-plane.md) | First-class local control plane with shared ASL, Lambda and host contracts | Accepted | M1–M5 |
| [0032](0032-on-demand-single-instance.md) | Run the game server on one on-demand EC2 instance | Accepted, supersedes [0004](0004-ec2-spot-for-the-game-server.md) | M0 |
| [0033](0033-connectivity-as-a-strategy.md) | Connectivity is a strategy behind one interface, constrained by the game's auth model | Proposed, amends [0024](0024-connectivity-modes.md) | M2 |
| [0034](0034-per-game-adapter.md) | A game is a module: data plus functions, minecraft the byte-identical default | Accepted | cross-cutting |
| [0035](0035-bootstrap-first-owner.md) | Bootstrap the first Owner through one verified Google identity | Superseded by [0037](0037-telegram-only-browser-identity.md) | M4 |
| [0036](0036-observed-visitors-and-owner-approved-access.md) | Observe visitors, but let an Owner grant access | Proposed | M4 |
| [0037](0037-telegram-only-browser-identity.md) | Telegram-only browser identity through signed Widget and Mini App payloads | Accepted | M4 |
| [0038](0038-invitation-delivery-claim.md) | Claim an invitation once before Telegram delivery | Accepted | M4 |
| [0039](0039-git-presets-instantiate-world-generations.md) | Git presets instantiate recoverable world generations | **Superseded** by [0040](0040-reusable-presets-and-world-wipes.md) | cross-cutting |
| [0040](0040-reusable-presets-and-world-wipes.md) | Reusable presets create worlds whose wipes own release state | Accepted | cross-cutting |
| [0041](0041-evaluate-spt-profile-backed-adapter.md) | Evaluate SPT as a profile-backed adapter without distributing EFT | Proposed | later |
| [0042](0042-preset-scoped-release-identity.md) | Release identity and storage are scoped by preset | Accepted | cross-cutting |

## Decisions still to record

Placeholders, so they are not forgotten. Deliberately unnumbered: a number is assigned when the ADR is
written, so the numbering stays chronological and nothing has to be renumbered when plans change.

- **CI for infrastructure.** Half answered on 2026-08-31: `.github/workflows/check.yml` runs `scripts/check.sh` on
  every push and pull request, which covers every rung that needs no credentials — links, shellcheck, the node tests,
  the containerised server suite, the mini app's build, and `fmt` plus `test` across all eleven Terraform roots. It
  holds `contents: read` and nothing else, and `scripts/check-workflows.py` fails the build if that changes, if an
  action stops being pinned to a commit, or if the workflow starts keeping its own copy of the rungs instead of
  calling the script.
  What remains is the half with an identity attached: whether `terraform plan` runs against real state. The mechanism
  is already answered by [ADR-0028](0028-update-proposals.md) — GitHub assumes an AWS role through OIDC with no
  stored keys — and a Terraform role would be the same mechanism with wider permissions, which is precisely why it
  stays a separate decision.
- **In-game verification of a Minecraft binding.** Only if a real conflict occurs, or when in-game events start
  naming people. Deferred deliberately in [ADR-0022](0022-minecraft-account-as-linked-identity.md).
- **Cost guardrail response.** Leaning answered by [docs/costs.md](../costs.md): **act, not merely notify.** A Budgets
  action that stops instances and denies expensive APIs, because against an egress or loop runaway a notification
  arrives after the money is spent. Needs the current Budgets action capabilities verified before it becomes an ADR.
- **Retiring a world.** Archived to cold storage and removed, or kept indefinitely. Needed before the first
  abandoned pack, not after. See [ADR-0023](0023-multiple-worlds.md).
- **Concurrent worlds on separate hosts.** Lifting ADR-0023's one-active-at-a-time to one instance per active world.
  Most of the design is ready by construction — per-world pointers and backup lineages, instance-parametric state
  machines, per-server lease semantics in Lifecycle V2, per-host watchdog economics. The mechanical seams, named so
  they do not rot in a conversation: the host Terraform root holds exactly one instance (a `for_each` over the
  catalog, with `moved` blocks protecting the live host), workflow IAM scopes mutations to one instance ARN (a list
  or a tag condition), the V2 lifecycle table is a single item (key by instance), the bot's single `INSTANCE_ID`
  becomes a world argument with catalog lookup, notifications must start naming the world, and the connection address
  becomes a catalog field. The one external ceiling: ZeroTier's ten free device slots — each concurrent host eats
  one, which is where [ADR-0033](0033-connectivity-as-a-strategy.md)'s non-gating strategies for Steam-auth games
  earn their place. **The same-host variant is the deeper change and the cheaper bill**: several servers on one
  instance breaks the load-bearing equation `session == instance lifetime` that ADR-0006, ADR-0032 and the stop
  machine are built on — idle stop must split into a world level (compose-stop that game) and a host level
  (StopInstances only when every world is idle, a last-one-out refcount the V2 lease model is the right foundation
  for), and the invariant gains a middle state, "somebody plays something". In exchange: one ZeroTier slot regardless
  of server count and one instance bill. **Hardware is a dial, never the argument** — the instance type is already a
  variable, and sizing for neighbours is a catalog value; what must be ready is the *code*, and its topology
  assumptions live in exactly three places: the unconditional `StopInstances` after a session stop, the single V2
  lifecycle item, and instance resolution as a singleton. The first seam is already cut: the catalog carries a
  per-world `host` (data, defaulting to the one host that exists), and `check-host-activity.sh` answers "may this
  host sleep once I stop?" — trivially idle today, a Choice state at V2 cutover tomorrow. Trigger for either form:
  two groups wanting different worlds on the same evening; the same-host form is the one to evaluate first when it
  fires.
- **Distribution model, if this is ever handed to other people.** "Clone the repo, authorise a browser, one command,
  a server in minutes" mixes two incompatible shapes: repo-clone needs credentials on the operator's own machine
  (`aws sso login` or a profile), while browser-authorise is the console / CloudFormation "Launch Stack" model. A
  hosted broker would unify them but reintroduces an always-on service and makes the author hold other people's AWS
  access — the operator line this project keeps declining to cross. The safe shape runs entirely in the operator's own
  account with the author never holding their credentials. Decide before the first outside user, not after.
- **Licence for this repository.** Public repository, so it needs one.
