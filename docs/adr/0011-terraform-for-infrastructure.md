# ADR-0011 — Manage the infrastructure with Terraform

- Status: Accepted
- Date: 2026-08-11
- Milestone: M1

## Context

The AWS side of this project is roughly thirty resources: VPC, subnet, route table, internet gateway,
security group, instance, volume, two buckets, several Lambda functions, an API, IAM roles and policies,
EventBridge rules, alarms, a hosted zone, a CloudFront distribution.

Clicked together in the console, that set is unreproducible and undocumented, and the region choice
becomes irreversible. Since the region is still an open question in [ADR-0002](0002-host-on-aws.md), being
able to rebuild everything elsewhere is not hypothetical.

Practising infrastructure as code is also one of the stated goals, so the tool needs to be the one used
in industry, not the most convenient one.

## Decision

Manage all AWS resources with Terraform, in `infra/terraform/`. State goes in an S3 backend with state
locking, created once by hand and documented — the usual bootstrap problem.

M0 is an explicit exception: a manual spike in the console, to learn what the resources actually are and
get something playable. Nothing from M0 survives. M1 rebuilds it in Terraform from scratch and deletes the
manual resources.

Secrets are not in Terraform variables or state. They live in SSM Parameter Store, created outside
Terraform and referenced by name.

## Consequences

**Good**

- The whole environment is reproducible, which makes a region change a rebuild instead of a redesign.
- Reviewable diffs. `terraform plan` before a change makes the blast radius visible.
- Deleting everything is one command, which matters for a project where an idle month should cost almost
  nothing.
- The skill transfers directly.

**Bad, or risky**

- Slower than clicking, especially while learning. This is the main reason M0 is exempt.
- State is itself critical: lose or corrupt it and Terraform no longer knows what it owns.
- Some things resist codification, notably anything created once by hand for bootstrap.
- Drift, if a console change is made in a hurry during an incident and never reconciled.

**Mitigations**

- S3 backend with versioning and locking, and the bootstrap steps written in the runbook.
- One environment only. No dev and prod copies of a hobby project — it doubles cost for no benefit.
- Record any deliberate console change and reconcile it in Terraform the same week.
- Terraform is not asked to manage the game server's contents. Mods and world are data, handled by the
  release pipeline. See [ADR-0009](0009-s3-as-mod-source-of-truth.md).

## Alternatives considered

| Option | Why not chosen |
| --- | --- |
| AWS CDK | Real programming language, strong ecosystem, and what the prior art uses. Rejected because Terraform is more widely used across employers, and CDK hides more of what is happening — the opposite of the goal here |
| CloudFormation directly | No extra tool to install, but verbose, slow to iterate, and AWS-only |
| Pulumi | Comparable to CDK. Smaller share of the market |
| Ansible | Good for configuring a host, weak at creating and destroying cloud resources with a state model |
| Shell scripts over the AWS CLI | Easy to start, no state model, so no way to reconcile or to plan a change |
| Console only | Fast today, unreproducible tomorrow. Permitted for M0 only, deliberately and briefly |

## Open questions

- Whether to split into modules early, or keep one flat configuration until it hurts. Flat first.
- Whether `terraform plan` runs in CI, and which AWS identity it uses. Listed as a decision still to record in
  the [ADR index](README.md).
