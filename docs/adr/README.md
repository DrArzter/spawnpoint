# Architecture decision records

One file per decision. Numbered, and immutable once accepted: to change a decision, write a new ADR and mark
the old one **Superseded by ADR-XXXX**. Never rewrite history in place.

Format and rationale: [ADR-0001](0001-record-architecture-decisions.md).
Template: [0000-template.md](0000-template.md).

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
| [0004](0004-ec2-spot-for-the-game-server.md) | Run the game server on EC2 Spot | Accepted | M0 |
| [0005](0005-containerised-game-server.md) | Run the game server in a container | Accepted | M0 |
| [0006](0006-on-demand-start-and-idle-shutdown.md) | Start on demand, stop when idle | Accepted | M2 |
| [0007](0007-ssm-instead-of-ssh.md) | Manage the instance with SSM, not SSH | Accepted | M1 |
| [0008](0008-versioned-mod-releases.md) | A mod set is an immutable, versioned release | Accepted | M3 |
| [0009](0009-s3-as-mod-source-of-truth.md) | S3 holds releases; promotion drives the deployment | Accepted | M3 |
| [0010](0010-world-persistence-and-backups.md) | World on persistent EBS, backups to S3 | Accepted, amended by [0026](0026-tiered-backups.md) | M1 |
| [0011](0011-terraform-for-infrastructure.md) | Manage the infrastructure with Terraform | Accepted | M1 |
| [0012](0012-web-control-panel.md) | One control-plane API; the panel is one client | Proposed | M4 |
| [0013](0013-modpack-distribution.md) | Distribute the client pack from S3 and CloudFront | Proposed | M4 |
| [0014](0014-no-kubernetes.md) | Do not use Kubernetes | Accepted | — |
| [0015](0015-observability-and-alerting.md) | CloudWatch signals, chat alerts, Budgets backstop | Proposed | M5 |
| [0016](0016-chat-integrations.md) | Discord and Telegram as control and notification surfaces | Proposed | M4 |
| [0017](0017-stable-server-address.md) | Stable hostname in Route 53, not an Elastic IP | Superseded by [0024](0024-connectivity-modes.md) | M2 |
| [0018](0018-identity-and-sign-in.md) | Cognito broker; panel sign-in with Google | Proposed | M4 |
| [0019](0019-account-linking.md) | Link chat accounts with a one-time code | Proposed | M4 |
| [0020](0020-email-channel.md) | SNS email for alerts; SES deferred | Accepted | M5 |
| [0021](0021-sign-in-from-linked-chat-account.md) | Chat sign-in, but only into an already linked account | Proposed | M4 |
| [0022](0022-minecraft-account-as-linked-identity.md) | Minecraft account is a linked identity; whitelist derived; `online-mode=false` | Proposed | M4 |
| [0023](0023-multiple-worlds.md) | Several worlds, one active at a time | Proposed | M6 |
| [0024](0024-connectivity-modes.md) | Connectivity is pluggable: raw address, DNS, or overlay | Proposed | M2 |
| [0025](0025-step-functions-for-long-operations.md) | Step Functions for long operations; Lambda for the rest | Proposed | M2 |
| [0026](0026-tiered-backups.md) | Tiered backups: incremental snapshots, infrequent archives | Proposed | M1 |

## Decisions still to record

Placeholders, so they are not forgotten. Deliberately unnumbered: a number is assigned when the ADR is
written, so the numbering stays chronological and nothing has to be renumbered when plans change.

- **CI for infrastructure.** Whether `terraform plan` runs in GitHub Actions, and which AWS identity it uses.
  OIDC, with no long-lived access keys, is the assumption.
- **In-game verification of a Minecraft binding.** Only if a real conflict occurs, or when in-game events start
  naming people. Deferred deliberately in [ADR-0022](0022-minecraft-account-as-linked-identity.md).
- **Cost guardrail response.** What a Budgets breach actually does: notify only, or stop the instance.
- **Retiring a world.** Archived to cold storage and removed, or kept indefinitely. Needed before the first
  abandoned pack, not after. See [ADR-0023](0023-multiple-worlds.md).
- **Licence for this repository.** Public repository, so it needs one.
