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

Forty-three records is a wall, and a wall is not a plan. Read the two or three that cover what you are building now.

| To do this | You need |
| --- | --- |
| ~~Session zero and M0~~ | **Done.** [docs/aws-m0-command-log.md](../aws-m0-command-log.md) records what was actually run |
| ~~M1~~ | **Done.** [0011](0011-terraform-for-infrastructure.md), [0010](0010-world-persistence-and-backups.md), [0007](0007-ssm-instead-of-ssh.md) |
| ~~M2~~ | **Done**, and re-based on Lifecycle V2 on 2026-09-11 — [docs/lifecycle-v2-rollout.md](../lifecycle-v2-rollout.md). The decisions: [0006](0006-on-demand-start-and-idle-shutdown.md), [0025](0025-step-functions-for-long-operations.md), [0032](0032-on-demand-single-instance.md) |
| M3 — releases and the pipeline | [0008](0008-versioned-mod-releases.md), [0030](0030-desired-and-active-release.md), [0042](0042-preset-scoped-release-identity.md); then [0028](0028-update-proposals.md) and [0029](0029-preview-environments.md), still proposed |
| M4 — surfaces and identity | Built on [0045](0045-provider-neutral-login-sessions.md), [0055](0055-sign-in-with-email-and-password-by-default.md), [0036](0036-observed-visitors-and-owner-approved-access.md) and [0012](0012-web-control-panel.md); [0016](0016-chat-integrations.md) stays open for Discord |
| Worlds, wipes, presets and games | [0040](0040-reusable-presets-and-world-wipes.md), [0034](0034-per-game-adapter.md), [0033](0033-connectivity-as-a-strategy.md) |
| Deploying a change to production | [0043](0043-deploy-production-from-reviewed-pull-requests.md), [0044](0044-apply-github-identities-behind-an-owner-gate.md) |
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
| [0019](0019-account-linking.md) | Link chat accounts with a one-time code | **Superseded** by [0057](0057-link-login-providers-through-the-current-identity.md) | M4 |
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
| [0033](0033-connectivity-as-a-strategy.md) | Connectivity is a strategy behind one interface, constrained by the game's auth model | Accepted, amends [0024](0024-connectivity-modes.md) | M2 |
| [0034](0034-per-game-adapter.md) | A game is a module: data plus functions, minecraft the byte-identical default | Accepted | cross-cutting |
| [0035](0035-bootstrap-first-owner.md) | Bootstrap the first Owner through one verified Google identity | Superseded by [0037](0037-telegram-only-browser-identity.md) | M4 |
| [0036](0036-observed-visitors-and-owner-approved-access.md) | Observe visitors, but let an Owner grant access | Accepted, amended by [0050](0050-default-role-on-sign-in-and-elevation-requests.md) | M4 |
| [0037](0037-telegram-only-browser-identity.md) | Telegram-only browser identity through signed Widget and Mini App payloads | **Superseded** by [0045](0045-provider-neutral-login-sessions.md) | M4 |
| [0038](0038-invitation-delivery-claim.md) | Claim an invitation once before Telegram delivery | Accepted | M4 |
| [0039](0039-git-presets-instantiate-world-generations.md) | Git presets instantiate recoverable world generations | **Superseded** by [0040](0040-reusable-presets-and-world-wipes.md) | cross-cutting |
| [0040](0040-reusable-presets-and-world-wipes.md) | Reusable presets create worlds whose wipes own release state | Accepted | cross-cutting |
| [0041](0041-evaluate-spt-profile-backed-adapter.md) | Evaluate SPT as a profile-backed adapter without distributing EFT | Proposed | later |
| [0042](0042-preset-scoped-release-identity.md) | Release identity and storage are scoped by preset | Accepted | cross-cutting |
| [0043](0043-deploy-production-from-reviewed-pull-requests.md) | Deploy production from reviewed pull requests through OIDC roles | Accepted, amended by [0044](0044-apply-github-identities-behind-an-owner-gate.md) | cross-cutting |
| [0044](0044-apply-github-identities-behind-an-owner-gate.md) | Apply the GitHub identities from the pipeline, behind an owner gate | Accepted | cross-cutting |
| [0045](0045-provider-neutral-login-sessions.md) | Keep login sessions independent of identity providers | Accepted | M4 |
| [0046](0046-keep-dynamodb-until-relational-needs-arrive.md) | Keep DynamoDB until relational needs arrive | Accepted | cross-cutting |
| [0047](0047-normalize-preset-sources-before-building.md) | Normalize preset sources before building | Accepted | cross-cutting |
| [0048](0048-one-instance-per-active-world.md) | One instance per active world, created for the session | Proposed | later |
| [0049](0049-project-control-plane-events-into-dynamodb.md) | Project control-plane events into DynamoDB for user-facing surfaces | Accepted | cross-cutting |
| [0050](0050-default-role-on-sign-in-and-elevation-requests.md) | Join as Viewer through any login provider, and ask for more | Proposed | M4 |
| [0051](0051-restart-a-session-without-releasing-the-host.md) | Restart a session without releasing the host | Proposed | M4 |
| [0052](0052-keep-a-release-while-a-generation-names-it.md) | Keep a release while a generation names it, and check before restoring | Proposed | M4 |
| [0053](0053-tell-not-built-apart-from-broken.md) | Tell "not built yet" apart from "broken", in the transport | Proposed | M4 |
| [0054](0054-place-a-session-on-a-host-with-room.md) | Place a session on a host with room, or launch one that fits | Proposed | later |
| [0055](0055-sign-in-with-email-and-password-by-default.md) | Sign in with email and password by default, and with a provider as an alternative | Accepted — implemented | M4 |
| [0056](0056-verify-and-link-password-credentials.md) | Verify and link password credentials without making a provider primary | Accepted — implemented; amends [0055](0055-sign-in-with-email-and-password-by-default.md) | M4 |
| [0057](0057-link-login-providers-through-the-current-identity.md) | Link login providers through the current Identity | Accepted — implemented | M4 |
| [0058](0058-sign-in-with-google.md) | Sign in with Google as one more proof-based provider, off until configured | Accepted — implemented | M4 |
| [0059](0059-separate-the-console-into-bones-and-skins.md) | Separate the console into bones and skins, and hold every skin to one contract | Accepted — implemented | M4 |

## Decisions still to record

Placeholders, so they are not forgotten. Deliberately unnumbered: a number is assigned when the ADR is
written, so the numbering stays chronological and nothing has to be renumbered when plans change.

- ~~**CI for infrastructure.**~~ Recorded as [ADR-0043](0043-deploy-production-from-reviewed-pull-requests.md) on
  2026-09-12. The credential-free half landed on 2026-08-31 — `check.yml` runs `scripts/check.sh` with `contents: read`
  and a hygiene check keeps it that way. The half with an identity attached landed on 2026-09-12: a pull request
  receives a read-only production plan through an owner-gated OIDC role, and a passing `Check` on `main` deploys the
  changed units through a separate deploy role that refuses deletes and replacements.
- **In-game verification of a Minecraft binding.** Only if a real conflict occurs, or when in-game events start
  naming people. Deferred deliberately in [ADR-0022](0022-minecraft-account-as-linked-identity.md).
- **Cost guardrail response.** Leaning answered by [docs/costs.md](../costs.md): **act, not merely notify.** A Budgets
  action that stops instances and denies expensive APIs, because against an egress or loop runaway a notification
  arrives after the money is spent. Needs the current Budgets action capabilities verified before it becomes an ADR.
- ~~**Retiring a world.**~~ Answered by [ADR-0040](0040-reusable-presets-and-world-wipes.md): archiving keeps the
  record and every backup; purging an archived world removes all of it behind a typed confirmation, permanently.
- ~~**Concurrent worlds on separate hosts.**~~ Recorded as [ADR-0048](0048-one-instance-per-active-world.md) on
  2026-09-14: one instance per active world, created for the session and terminated with it, world data restored from
  S3 rather than held on a per-world volume, and the address supplied per world by the strategy of
  [ADR-0033](0033-connectivity-as-a-strategy.md), which is what lifts the overlay's ten-device ceiling. Capacity stays
  data, so no placement algorithm is written. **The same-host variant stays open**, and remains the cheaper bill and
  the deeper change; ADR-0048 carries forward the two obstacles that were about to be rediscovered, the RCON port both
  Factorio and Project Zomboid bind today and the `SRV` asymmetry between the games. It also widens ADR-0006's recorded
  waiting budget from three minutes to ten, on the owner's ruling that a group will wait if waiting is what keeps the
  bill at nothing, and makes an always-ready world a per-world policy with its cost attached. One correction to what this
  placeholder claimed: the catalog carries a per-world `connectivity`, not a per-world `host`, so that seam is not cut
  yet.
  **The same-host variant is now recorded** as [ADR-0054](0054-place-a-session-on-a-host-with-room.md) on 2026-09-17:
  a start places its session on the ready host that leaves the least room, and launches a host that fits
  when none has; a world declares a footprint that becomes its container's hard limit; a slot per reservation is the
  port allocator; the stop becomes two decisions, the session's and the host's, with a grace period between them.
  ADR-0048's S3 home, waiting budget, `cold`/`warm` policy and verified-archive gate all carry over. The domain module
  and its tests landed with the ADR; the rollout is in [docs/capacity-allocation-rollout.md](../capacity-allocation-rollout.md).
- **Distribution model, if this is ever handed to other people.** "Clone the repo, authorise a browser, one command,
  a server in minutes" mixes two incompatible shapes: repo-clone needs credentials on the operator's own machine
  (`aws sso login` or a profile), while browser-authorise is the console / CloudFormation "Launch Stack" model. A
  hosted broker would unify them but reintroduces an always-on service and makes the author hold other people's AWS
  access — the operator line this project keeps declining to cross. The safe shape runs entirely in the operator's own
  account with the author never holding their credentials. Decide before the first outside user, not after.
- **Licence for this repository.** Public repository, so it needs one.
