# Cost model

**Every number in this file is a placeholder for illustration, not a quoted AWS price.** Rates differ by
region, change over time, and Spot prices move continuously. Replace each one from the AWS pricing pages
and the AWS Pricing Calculator for the chosen region before relying on any of it. Region is still an open
question. See [ADR-0002](adr/0002-host-on-aws.md).

The purpose of this document is the shape of the cost, and which decisions move it. That shape is stable
even when the rates are not.

## Target

| | Target |
| --- | --- |
| Fixed cost — billed whether anybody plays or not | A few USD per month |
| Total, for a few evenings of play a week | Low double-digit USD per month |

The fixed part is the number that matters. A variable cost that only appears when the server is in use is
easy to accept; a fixed cost is paid during the months when nobody plays at all.

## The model

```
monthly cost =
      running_hours x (instance_rate + public_ipv4_rate)     variable
    + volume_gb x ebs_rate                                   fixed
    + backup_gb x storage_rate                               fixed, grows slowly
    + hosted_zone_rate                                       fixed
    + requests and egress (Lambda, API, CloudFront, S3)       usually inside the free tier
```

Two decisions do almost all of the work on the variable term, and they multiply:

- **Stop when idle.** Roughly 40 running hours a month instead of 730. See [ADR-0006](adr/0006-on-demand-start-and-idle-shutdown.md).
- **Spot instead of on-demand.** Typically a large discount on the same hardware. See [ADR-0004](adr/0004-ec2-spot-for-the-game-server.md).

## Drivers

| Driver | Type | Placeholder rate | Notes |
| --- | --- | --- | --- |
| EC2 Spot, ~4 vCPU / 16 GB | Variable | $0.06 per hour | Assume roughly a third of the on-demand rate; verify per type and zone, and expect movement |
| Public IPv4 address | Variable here | $0.005 per hour | Charged for any public address; verify. Only billed while running, because no Elastic IP is held. See [ADR-0017](adr/0017-stable-server-address.md) |
| EBS gp3, world volume, 50 GB | Fixed | $0.09 per GB-month | Billed while the instance is stopped. The largest fixed item |
| S3 Standard, backups, 20 GB | Fixed | $0.023 per GB-month | Lifecycle to a colder class reduces this. See [ADR-0010](adr/0010-world-persistence-and-backups.md) |
| S3, release store, 10 GB | Fixed | $0.023 per GB-month | Grows with retained releases |
| Route 53 hosted zone | Fixed | $0.50 per zone-month | Plus a negligible per-query charge |
| Lambda, API Gateway, DynamoDB | Variable | Effectively nil | A few thousand invocations a month sits inside the perpetual free tier |
| CloudFront and S3 egress | Variable | Effectively nil | A handful of pack downloads a month |
| Game traffic egress | Variable | Small | Tens of MB per player-hour; verify the free allowance and the per-GB rate |
| CloudWatch logs and custom metrics | Variable | Small, and easy to overspend | Short retention, few custom metrics. See [ADR-0015](adr/0015-observability-and-alerting.md) |
| Domain registration | Fixed, annual | Varies | Only if a domain is not already owned |

## Worked example

Placeholder rates from the table, 40 running hours in the month. Arithmetic shown so real rates can be
substituted directly.

| Item | Calculation | Monthly |
| --- | --- | --- |
| Instance | 40 h x $0.06 | $2.40 |
| Public IPv4 | 40 h x $0.005 | $0.20 |
| World volume | 50 GB x $0.09 | $4.50 |
| Backups | 20 GB x $0.023 | $0.46 |
| Release store | 10 GB x $0.023 | $0.23 |
| Hosted zone | | $0.50 |
| Serverless, egress, logs | inside free tier, plus a margin | ~$0.50 |
| **Total** | | **~$8.80** |
| **of which fixed** | volume, storage, zone | **~$5.70** |

The instance is not the main cost. The **storage is**, because it is billed continuously while everything
else is billed only during a session. That is the counter-intuitive result of an on-demand design, and it
is where optimisation effort belongs: size the volume tightly, prune old worlds, lifecycle the backups.

## What makes it much worse

Each of these is larger than the entire example above.

| Trap | Approximate cost | Avoided by |
| --- | --- | --- |
| NAT Gateway | ~$32 per month, plus data processing | Instance in a public subnet, no private subnet. See [ADR-0004](adr/0004-ec2-spot-for-the-game-server.md) |
| EKS control plane | ~$73 per month per cluster, before any node; more on extended support | Not using Kubernetes. See [ADR-0014](adr/0014-no-kubernetes.md) |
| An instance that never stopped | 730 h instead of 40, roughly 18x the compute | Idle watchdog, plus a running-hours alarm |
| On-demand instead of Spot | Several times the hourly rate | [ADR-0004](adr/0004-ec2-spot-for-the-game-server.md) |
| An Elastic IP held all month | ~$3.60 per month | DNS record updated on start. See [ADR-0017](adr/0017-stable-server-address.md) |
| Orphaned volumes and snapshots | Silent and cumulative | Terraform owns everything; tag and review monthly |
| Verbose logs with indefinite retention | Grows without limit | Short retention, filtered log shipping |
| An always-on component of any kind | Whatever it costs, forever | Everything is event-driven. This is why there is no hosted bot or proxy |

## Guardrails

In order of when they go in.

1. **AWS Budgets alarm before the first long-running resource exists.** Not after the first surprising bill.
   Notify by chat and email.
2. **Tag every resource** with a project tag, so Cost Explorer can attribute and orphans can be found.
3. **CloudWatch alarm on continuous running hours**, which catches a failed stop long before the bill does.
4. **A monthly look at Cost Explorer**, grouped by service. Five minutes, and it is how orphans are found.
5. **`terraform destroy` is a supported action.** If the group stops playing for a season, tearing down and
   keeping only the S3 backups should be a documented, tested path.

## Comparison, for honesty

A managed Minecraft host would cost roughly $5–15 per month for a comparable modded server, with no
engineering effort, no cold start and a support channel.

This project is not cheaper in money, and it is far more expensive in time. It buys control over the mod
pipeline, and it buys the learning, which is the declared reason it exists. See
[ADR-0003](adr/0003-build-not-reuse.md). Pretending otherwise in a README would be dishonest, and an
interviewer would spot it immediately.

## To verify

- [ ] Region choice, and the Spot price history for the candidate instance types in it.
- [ ] Current public IPv4 hourly rate.
- [ ] gp3 rate in the chosen region, and whether the world fits in less than 50 GB.
- [ ] Free-tier allowances currently applying to this account for Lambda, CloudFront and data transfer.
- [ ] Colder storage class for backups older than a month, and its retrieval cost.
- [ ] The monthly figure to set the Budgets alarm at.
