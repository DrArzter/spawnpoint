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
| Fixed cost — billed whether anybody plays or not | Under $3 per month |
| Total, at 2–3 hours most nights | Mid single-digit USD per month |

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

- **Stop when idle.** Roughly 75 running hours a month instead of 730. See [ADR-0006](adr/0006-on-demand-start-and-idle-shutdown.md).
- **Spot instead of on-demand.** Typically a large discount on the same hardware. See [ADR-0004](adr/0004-ec2-spot-for-the-game-server.md).

## Drivers

| Driver | Type | Placeholder rate | Notes |
| --- | --- | --- | --- |
| EC2 Spot, ~2 vCPU / 8 GB | Variable | $0.03 per hour | Sized from operator experience: 2 cores and 4 GB is often enough, 4 cores and 16 GB is comfortable for anything. Starting in the middle. Assume roughly a third of the on-demand rate; verify per type and zone |
| Public IPv4 address | Variable here | $0.005 per hour | Charged for any public address; verify. Only billed while running, because no Elastic IP is held. Applies in **every** connectivity mode, because the instance needs outbound access regardless. See [ADR-0024](adr/0024-connectivity-modes.md) |
| EBS gp3, data volume, 20 GB | Fixed | $0.09 per GB-month | Billed while the instance is stopped. Sized for mod releases and several worlds, not for save data — the worlds themselves are a few hundred MB each. See [ADR-0023](adr/0023-multiple-worlds.md) |
| S3, world backups | Fixed | $0.023 per GB-month | Full archive after every session. Retention 5 daily, 2 weekly, 2 monthly — nine copies, well under a gigabyte. See [ADR-0010](adr/0010-world-persistence-and-backups.md) |
| S3, release store, 10 GB | Fixed | $0.023 per GB-month | Grows with retained releases |
| Route 53 hosted zone | Fixed | $0.50 per zone-month | **Only in DNS mode.** Plus a negligible per-query charge. See [ADR-0024](adr/0024-connectivity-modes.md) |
| Overlay network | Fixed | $0 within the free tier | **Only in overlay mode.** Free tiers bind on different axes: ZeroTier 10 devices and 1 network; Tailscale 6 users with unlimited devices. Either cliff costs more than this whole table. See [ADR-0024](adr/0024-connectivity-modes.md) |
| Lambda, API Gateway, DynamoDB | Variable | Effectively nil | A few thousand invocations a month sits inside the perpetual free tier |
| CloudFront and S3 egress | Variable | Effectively nil | A handful of pack downloads a month |
| Game traffic egress | Variable | Small | Tens of MB per player-hour; verify the free allowance and the per-GB rate |
| CloudWatch logs and custom metrics | Variable | Small, and easy to overspend | Short retention, few custom metrics. See [ADR-0015](adr/0015-observability-and-alerting.md) |
| Domain registration | Fixed, annual | Varies | Only if a domain is not already owned |

## Worked example

Placeholder rates from the table. The expected pattern is **2–3 hours most nights**, so roughly **75 running hours a
month** — not the 40 an earlier version of this document assumed. Arithmetic shown so real rates can be substituted
directly.

| Item | Calculation | Monthly |
| --- | --- | --- |
| Instance | 75 h x $0.03 | $2.25 |
| Public IPv4 | 75 h x $0.005 | $0.38 |
| Data volume | 20 GB x $0.09 | $1.80 |
| Backups | 9 archives x ~0.3 GB x $0.023 | ~$0.06 |
| Release store | 10 GB x $0.023 | $0.23 |
| Hosted zone | | $0.50 |
| Serverless, egress, logs | inside free tier, plus a margin | ~$0.50 |
| **Total** | | **~$5.70** |
| **of which fixed** | volume, storage, zone | **~$2.60** |

### Sensitivity to running hours

The single number matters less than the slope, because hours are the one input most likely to change:

| Pattern | Hours/month | Total |
| --- | --- | --- |
| A few evenings a week | 40 | ~$4.50 |
| 2–3 h most nights | 75 | ~$5.70 |
| 3 h every night | 90 | ~$6.20 |
| Always on | 730 | ~$29 |

Every extra hour costs about 3.5 cents at these placeholder rates. The always-on row is still five times the expected
one, which is the argument for the whole design.

The hosted-zone line applies in DNS mode only; in the other two connectivity modes it is nil or the overlay's free
tier. See [ADR-0024](adr/0024-connectivity-modes.md).

### Which line dominates

This document has answered that question three times and got a different answer each time, because the inputs kept
arriving. With the world measured and the instance sized from experience rather than guesswork, it settles:

| | Monthly | Note |
| --- | --- | --- |
| Variable — running hours | ~$2.60 | Instance and its public address, at 75 h |
| Fixed — storage and DNS | ~$2.60 | Volume, backups, release store, hosted zone |

**Neither dominates.** Roughly half and half, on a bill of about six dollars. So there is no single lever worth
optimising, and two worth not getting wrong: **hours** — a failed stop is still the one mistake that multiplies the
bill — and **instance size**, which moved this total by 30% in one step. Save data is not a cost factor at all.

Earlier versions of this section declared first storage and then running hours the dominant term. Both followed from
placeholders that have since been replaced with real figures.

### With several worlds

Only one world runs at a time, so **compute does not change at all** — four worlds cost the same to play as one. And at
a few hundred megabytes each, their save data and backups add cents, not dollars. Mod storage grows sub-linearly
because binaries are content-addressed and shared between packs.

So several packs are, to a first approximation, free. The on-demand design is what makes that true: their cost would
have been compute, and compute is only billed while playing. See [ADR-0023](adr/0023-multiple-worlds.md).

## What makes it much worse

Each of these is larger than the entire example above.

| Trap | Approximate cost | Avoided by |
| --- | --- | --- |
| NAT Gateway | ~$32 per month, plus data processing | Instance in a public subnet, no private subnet. See [ADR-0004](adr/0004-ec2-spot-for-the-game-server.md) |
| EKS control plane | ~$73 per month per cluster, before any node; more on extended support | Not using Kubernetes. See [ADR-0014](adr/0014-no-kubernetes.md) |
| An instance that never stopped | 730 h instead of 75, roughly 10x the compute | Idle watchdog, plus a running-hours alarm |
| On-demand instead of Spot | Several times the hourly rate | [ADR-0004](adr/0004-ec2-spot-for-the-game-server.md) |
| An Elastic IP held all month | ~$3.60 per month | DNS record updated on start. See [ADR-0017](adr/0017-stable-server-address.md) |
| Orphaned volumes and snapshots | Silent and cumulative | Terraform owns everything; tag and review monthly |
| Verbose logs with indefinite retention | Grows without limit | Short retention, filtered log shipping |
| Full world archives × retention, **if a world ever grows large** | World size × 9. Harmless at a few hundred MB; a 40 GB world would cost ~$8 a month in backups alone | Watch for a world approaching ~30 GB, then reopen [ADR-0026](adr/0026-tiered-backups.md) |
| An always-on component of any kind | Whatever it costs, forever | Everything is event-driven. This is why there is no hosted bot or proxy |
| Outgrowing the overlay's free tier | Tens of US dollars monthly, several times this whole table | Count what the chosen vendor limits — people or devices — and decide at the cliff, not after. Self-hosted WireGuard is the escape. See [ADR-0024](adr/0024-connectivity-modes.md) |

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

This is the section to read before defending the project to anybody, including yourself.

Real quoted prices from one hourly-billed provider, rather than invented ones, at **75 hours a month**. Its plans come
in a **shared** CPU tier and a **dedicated** one.

| Option | At 75 h | Flat, 24/7 | Spec |
| --- | --- | --- | --- |
| **This design**, EC2 **Spot** | ~$5.70 | — | 2 vCPU / 8 GB |
| VPS, **dedicated** CPU | ~€7.50 | €16.98 | 2 core / 4 GB — "often enough" |
| VPS, **shared** CPU | ~€10.50 | €23.73 | 4 core / 8 GB |
| VPS, **dedicated** CPU | ~€14.25 | €33.94 | 4 core / 8 GB |
| VPS, **dedicated** CPU | ~€28.50 | €67.86 | 8 core / 16 GB — "runs anything" |

**Shared CPU is the wrong comparison for a game server.** The main game tick is effectively single-threaded and
latency-sensitive, so contention on an oversubscribed host shows up directly as tick lag — the thing players feel. EC2's
general-purpose families give real vCPUs rather than burstable credits, so the honest comparison is against the
*dedicated* rows.

Read that way the ordering is clear, and it settles an argument this document has now had three times:

**EC2 Spot is the cheapest option on the table for like-for-like dedicated CPU** — roughly half the dedicated VPS at 8 GB,
and a third of it at 16 GB. EC2 on-demand lands about level with the dedicated 8 GB tier. The Spot discount is doing all
of that work, which is exactly why [ADR-0027](adr/0027-spot-request-shape.md) treats it as load-bearing rather than as an
optimisation.

So the trade is now precise. Moving the game server to a rented box costs roughly **€6–20 a month more**, and buys: no
capacity risk, no interruptions, no fleet, no AMI, a static address, and a shorter cold start. That is a real thing to
buy. It is simply not a discount, and this document previously implied it was.

**One measurement now has money attached.** Whether the pack needs 8 GB or 16 GB decides between the €14 and €28 tiers,
and between EC2 sizes. See item 2 in [docs/measurements.md](measurements.md).

Worth knowing where the fork actually is: most of this project is **not** AWS-specific. The release model, the client
packs, the control-plane API, the bots and the linking design would all work against a rented box. What a flat-rate box
removes is exactly the on-demand lifecycle — start, idle stop, interruption handling, connectivity that changes on every
boot — which is the part with the most transferable engineering in it.

### How often Spot actually interrupts, and why it matters to the bill

AWS's Spot Instance Advisor reports interruption frequency in bands — under 5%, 5–10%, 10–15%, 15–20%, over 20% — measured
as the rate at which capacity was reclaimed over the trailing month. The historical average across regions and instance
types is **below 5%**, and that figure is for an instance running the whole month. This design runs about a tenth of the
month, so the realistic expectation for a well-chosen type is a handful of interruptions a year, not a weekly event.

When one happens it costs an interruption to the evening, not data: two minutes of warning, a confirmed world save, a
clean stop, and everybody reconnects after the next start having lost seconds. See
[ADR-0004](adr/0004-ec2-spot-for-the-game-server.md).

The part that matters here is that **the Spot discount is load-bearing for the whole cost argument, not an optimisation on
top of it.** If the chosen instance type turns out to sit in a bad band and the fallback to on-demand is taken, the compute
line roughly triples — about $13.50 instead of $4.50 at 75 hours — taking the total to roughly $17 a month. At that point
the Hetzner comparison above is not close either, and it goes the other way.

So: check the Advisor for the specific candidate types in the chosen region **before** committing to the region, and allow
several instance types rather than one. AWS's own advice is to diversify across types and availability zones; the zonal
EBS volume limits us to types within one zone, which is a trade already recorded in
[ADR-0004](adr/0004-ec2-spot-for-the-game-server.md).

So the on-demand design only pays for itself in the other currency. Stopping when idle, surviving Spot interruptions,
separating state from compute, a release pipeline with rollback, orchestration, cost guardrails — those are the deliverable.
See [ADR-0003](adr/0003-build-not-reuse.md).

### One assumption behind every figure here

**A single, long-lived AWS account.** Not a rotation of new accounts for their introductory allowances.

That matters for three reasons, in ascending order of how much they should weigh:

1. **It would not help.** The introductory compute allowance covers a 1 GB micro instance, which cannot run a modded
   server at all. The volume, at roughly $1.80, is the only line it meaningfully touches. So it would save a couple of
   dollars on the ~$8 that this document is about, while the real expense — a 16 GB instance by the hour — is not covered
   by any free tier. Verify the current terms before assuming otherwise; AWS restructured its free tier recently and the
   details have moved.
2. **It breaks the system.** This project's whole point is durable state: a world with hundreds of hours in it, a release
   history, backups with two months of reach. An account with an expiry date cannot hold any of that, and migrating a
   world plus its backups plus its infrastructure annually is not a plan.
3. **It contradicts the goal.** Creating accounts to circumvent free-tier limits is against the AWS Customer Agreement,
   and enforcement is real — accounts get linked by payment instrument and closed. More to the point, this project exists
   partly to be described to an employer. "I rotate free accounts" is a poor answer in a conversation about billing
   hygiene, IAM discipline and audit trails, which are precisely the topics this repository is designed to show off.

The honest version of the cost argument is simpler and stronger: **$8 a month is cheap for a training environment that
also happens to be the server your friends play on.** It does not need a discount to be worth it.

## To verify

- [ ] Region choice, and the Spot price history for the candidate instance types in it.
- [ ] Current public IPv4 hourly rate.
- [ ] gp3 rate in the chosen region, and whether the world fits in less than 50 GB.
- [ ] Free-tier allowances currently applying to this account for Lambda, CloudFront and data transfer.
- [ ] Colder storage class for backups older than a month, and its retrieval cost.
- [ ] The monthly figure to set the Budgets alarm at.
- [ ] Head count and device count for the actual group, which decides which overlay vendor's free tier fits. See
      [ADR-0024](adr/0024-connectivity-modes.md).
- [ ] Whether a player given access as a *shared device* counts towards Tailscale's 6-user limit, if that vendor is
      chosen after all.
- [ ] Real world size per pack, once one exists. It sets the volume size, which is the dominant fixed cost.
