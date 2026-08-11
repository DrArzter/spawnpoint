# ADR-0002 — Host on AWS

- Status: Accepted
- Date: 2026-08-11
- Milestone: M0

## Context

The platform must run somewhere that supports: per-second or per-hour billing on compute, an API to
start and stop that compute, object storage with event notifications, a way to run code on an event
without a server of its own, and DNS under API control.

Learning value carries equal weight with price, because practising production engineering is a
declared goal of this project, not a side effect. See [ADR-0003](0003-build-not-reuse.md).

A dedicated Minecraft hosting provider would be cheaper and simpler for the game alone, and teaches
nothing that transfers to work.

## Decision

Build on AWS, in a single region close to most players. Region choice is an open question below.

Use the smallest set of services that does the job: EC2, EBS, S3, Lambda, API Gateway, EventBridge,
SSM, CloudWatch, Route 53, CloudFront.

## Consequences

**Good**

- The largest market share of the major providers, so the skills transfer directly, and every failure
  mode is already documented by somebody else.
- Spot pricing, per-second billing and stop/start over an API make the on-demand model possible.
- The free tier absorbs most of the Lambda, CloudWatch and S3 request cost at this scale.

**Bad, or risky**

- The most intricate pricing model of the major providers. Cost surprises come from services that
  look free until they are not: NAT Gateway, public IPv4 addresses, cross-AZ traffic, orphaned
  snapshots.
- IAM is a real learning curve. That is partly the point, but it slows the first milestone.
- Lock-in in the automation layer. Terraform limits it for the resources, not for the service choices.

**Mitigations**

- An AWS Budgets alarm exists before any long-running resource does. See [ADR-0015](0015-observability-and-alerting.md).
- No NAT Gateway in the design: the instance sits in a public subnet. See [ADR-0004](0004-ec2-spot-for-the-game-server.md).
- Tag every resource with a project tag, so cost can be attributed and orphans can be found.

## Alternatives considered

| Option | Why not chosen |
| --- | --- |
| Hetzner or OVH VPS / dedicated | Far better price per GB of RAM, but billed monthly, so stopping the server saves nothing, and the event-driven tooling is weaker |
| Oracle Cloud always-free ARM | Genuinely free with enough RAM, but capacity is frequently unavailable, and the ecosystem teaches little |
| Managed Minecraft host | Cheapest and simplest for playing, but no infrastructure to learn from and no control over the mod pipeline |
| GCP or Azure | Comparable capability. AWS chosen for market share and existing familiarity |
| Home server | Free compute, but exposes a home connection, and uptime depends on the household |

## Open questions

- **Region.** Latency for the actual group decides this. Candidates: `eu-west-2` (London),
  `eu-central-1` (Frankfurt), `eu-north-1` (Stockholm, often the cheapest in Europe). Measure before
  M1: moving region later means recreating everything.
- Whether a separate AWS account is worth the setup effort, to keep the blast radius and the bill
  clearly separated from anything else.
