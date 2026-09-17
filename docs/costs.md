# Cost model

Current rates verified for `eu-central-1`: Free-Plan-eligible `m7i-flex.large` at **$0.11471 per hour**,
`r8i-flex.large` at **$0.15920 per hour**, and gp3 at **$0.0952 per GB-month**, read from AWS APIs on 2026-08-13;
public IPv4 is **$0.005 per hour**, verified against [Amazon VPC pricing](https://aws.amazon.com/vpc/pricing/). S3 and
serverless figures below remain estimates.
Rates change, so query them again before relying on this model later.

The purpose of this document is the shape of the cost, and which decisions move it. That shape is stable
even when the rates are not.

## Target

| | Target |
| --- | --- |
| Fixed cost — billed whether anybody plays or not | Under $3 per month |
| Total, at 2–3 hours most nights | Under the $20 monthly budget |

The fixed part is the number that matters. A variable cost that only appears when the server is in use is
easy to accept; a fixed cost is paid during the months when nobody plays at all.

## The model

```
monthly cost =
      running_hours x (instance_rate + public_ipv4_rate)     variable
    + (root_volume_gb + data_volume_gb) x ebs_rate            fixed
    + backup_gb x storage_rate                               fixed, grows slowly
    + hosted_zone_rate                                       fixed
    + requests and egress (Lambda, API, CloudFront, S3)       usually inside the free tier
```

**One decision does almost all of the work** on the variable term:

- **Stop when idle.** Roughly 75 running hours a month instead of 730 — the whole difference between about $12.45 and
  about $90.86 at the current list rate, before Free Plan credits. See
  [ADR-0006](adr/0006-on-demand-start-and-idle-shutdown.md).

There used to be a second, and it multiplied with the first: Spot instead of on-demand. It is deferred, and worth about
$8 a month against a large amount of machinery. See [ADR-0032](adr/0032-on-demand-single-instance.md) and
[ADR-0027](adr/0027-spot-request-shape.md).

## Drivers

| Driver | Type | Rate | Notes |
| --- | --- | --- | --- |
| **EC2 on-demand, `m7i-flex.large`** — 2 vCPU / 8 GiB | Variable | **$0.11471 per hour list; currently covered by Free Plan credits** | One-player AWS load peaked at 78.46% host memory with no OOM. Accepted while free, not proven for the full group. `r8i-flex.large` is the reviewed 2 vCPU / 16 GiB upgrade at $0.15920/hour and requires Paid Plan. See [ADR-0032](adr/0032-on-demand-single-instance.md) |
| Public IPv4 address | Variable here | **$0.005 per hour**, verified | Only billed while running, because no Elastic IP is held. Applies in **every** connectivity mode, because the instance needs outbound access regardless. See [ADR-0024](adr/0024-connectivity-modes.md) |
| EBS gp3, 8 GB root volume | Fixed | **$0.0952 per GB-month**, verified | The current official AL2023 AMI has an 8 GB root disk. A stopped instance retains and bills this volume; it was missing from the first model. It is disposable, unlike the data volume. |
| EBS gp3, 20 GB data volume | Fixed | **$0.0952 per GB-month**, verified | Billed while the instance is stopped. Sized for mod releases and several worlds, not for save data — the worlds themselves are a few hundred MB each. See [ADR-0023](adr/0023-multiple-worlds.md) |
| S3, world backups | Fixed | $0.023 per GB-month | Full archive after every session. The first real archive compressed the 598 MiB world to about 398 MiB, so retention of 5 daily, 2 weekly and 2 monthly is about 3.5 GiB at the observed ratio. See [ADR-0010](adr/0010-world-persistence-and-backups.md) |
| S3, release store, 10 GB | Fixed | $0.023 per GB-month | Grows with retained releases |
| Route 53 hosted zone | Fixed | ~~$0.50 per zone-month~~ **nil** | DNS mode only, and **ZeroTier was chosen** — so there is no hosted zone. See [ADR-0024](adr/0024-connectivity-modes.md) |
| Overlay network | Fixed | $0 within the free tier | **Only in overlay mode.** Free tiers bind on different axes: ZeroTier 10 devices and 1 network; Tailscale 6 users with unlimited devices. Either cliff costs more than this whole table. See [ADR-0024](adr/0024-connectivity-modes.md) |
| Lambda, API Gateway, DynamoDB | Variable | Effectively nil | A few thousand invocations a month sits inside the perpetual free tier |
| CloudFront and S3 egress | Variable | Effectively nil | A handful of pack downloads a month |
| Game traffic egress | Variable | Small | Tens of MB per player-hour; verify the free allowance and the per-GB rate |
| CloudWatch logs and custom metrics | Variable | Small, and easy to overspend | Short retention, few custom metrics. See [ADR-0015](adr/0015-observability-and-alerting.md) |
| Domain registration | Fixed, annual | Varies | Only if a domain is not already owned |

## Worked example

Current rates plus the remaining estimates from the table. The expected pattern is **2–3 hours most nights**, so roughly **75 running hours a
month** — not the 40 an earlier version of this document assumed. Arithmetic shown so real rates can be substituted
directly.

| Item | Calculation | Monthly |
| --- | --- | --- |
| Instance | 75 h x $0.11471 | $8.60 before credits |
| Public IPv4 | 75 h x $0.005 | $0.38 |
| Root volume | 8 GB x $0.0952 | $0.76 |
| Data volume | 20 GB x $0.0952 | $1.90 |
| Backups | 9 archives x ~0.389 GiB x $0.023 | ~$0.08 |
| Release store | 10 GB x $0.023 | $0.23 |
| Hosted zone | overlay mode — none | $0.00 |
| Serverless, egress, logs | inside free tier, plus a margin | ~$0.50 |
| **Total** | | **~$12.45 list; lower while credits apply** |
| **of which fixed storage** | both volumes, backups and releases | **~$2.98** |

The active instance is deliberately smaller than the paid target while the account remains on the Free Plan. At the
same 75 hours, the reviewed `r8i-flex.large` upgrade would put the total near **$15.79** before credits. The hosted zone
is absent because [ADR-0024](adr/0024-connectivity-modes.md) chose the overlay.

### Sensitivity to running hours

The single number matters less than the slope, because hours are the one input most likely to change:

| Pattern | Hours/month | Total |
| --- | --- | --- |
| A few evenings a week | 40 | ~$8.26 list |
| 2–3 h most nights | 75 | ~$12.45 list |
| 3 h every night | 90 | ~$14.25 list |
| **Always on** | 730 | **~$90.86 list** |

Every extra hour costs about **12 cents** at list rates now, and consumes Free Plan credits while they remain.

**That last row is the consequence of choosing on-demand, and it is the one to take seriously.** Credits hide cost;
they do not make a failed stop harmless, because they can be exhausted. The idle watchdog, running-hours alarm and hard
session cap in [ADR-0006](adr/0006-on-demand-start-and-idle-shutdown.md) remain mandatory.

The hosted-zone line applies in DNS mode only; in the other two connectivity modes it is nil or the overlay's free
tier. See [ADR-0024](adr/0024-connectivity-modes.md).

### Which line dominates

This document has answered that question four times now and got a different answer each time, because the inputs kept
arriving. So the useful thing is no longer the answer but the pattern:

| | Monthly | Note |
| --- | --- | --- |
| Variable — running hours | ~$3.76 | Instance and its public address, at 75 h |
| Fixed — storage and DNS | ~$2.60 | Volume, backups, release store, hosted zone |

Variable is now the larger share, at about three fifths. But **the split moves with instance size**, and sizing has now
moved this total twice — 30% down on operator experience, then 20% back up on measurement. That is the stable
observation: sizing is the lever, and it is the one input still resting on a single-player sample. Two things are worth
not getting wrong: **hours** — a failed stop is still the one mistake that multiplies the
bill — and **instance size**, which moved this total by 30% in one step. Save data is not a cost factor at all.

Earlier versions of this section declared first storage and then running hours the dominant term. Both followed from
placeholders that have since been replaced with real figures.

### With several worlds

Under [ADR-0023](adr/0023-multiple-worlds.md) one world ran at a time, so several packs cost nothing extra to play.
[ADR-0048](adr/0048-one-instance-per-active-world.md) lets two worlds run on the same evening on two hosts, and
[ADR-0054](adr/0054-place-a-session-on-a-host-with-room.md) lets a second world take a host that has room. This section
shows what each of those costs for one evening, so the choice between them is arithmetic rather than taste.

**The control plane never sees a price.** A launch states the footprint's requirements — minimum memory, minimum
cores, the allowed families — and EC2 Fleet answers with the cheapest instance that meets them at that moment. The
table below is therefore not a catalogue the code reads; it is what this replay uses to stand in for EC2's answer.
`m7i-flex.large` is the verified rate above. The others are us-east-1 list prices scaled by the ratio that rate implies
(about 1.2) — the pricing API needs credentials this checkout did not have on 2026-09-17 — and they change what the
replay says, never what the code does.

| What EC2 could answer with | vCPU | Memory | $/hour | Estimate? |
| --- | --- | --- | --- | --- |
| `m7i-flex.large` | 2 | 8 GiB | 0.1147 | verified 2026-08-13 |
| `r7i.large` | 2 | 16 GiB | ~0.159 | estimate; `r8i-flex.large` was read at 0.1592 |
| `r7i.xlarge` | 4 | 32 GiB | ~0.317 | estimate |
| `r7i.2xlarge` | 8 | 64 GiB | ~0.634 | estimate |

**Footprints** are the unit of placement: the container's hard limit, not the heap. The modded Minecraft figure is the
measurement in [docs/measurements.md](measurements.md); the others are placeholders for the catalog to replace.

| World | Memory | Core weight |
| --- | --- | --- |
| Modded Minecraft (4 GiB heap) | 6 GiB | 1 |
| Vanilla Minecraft | 3 GiB | 0.5 |
| Factorio | 2 GiB | 0.5 |
| Project Zomboid | 6 GiB | 1 |

**One evening, four settings.** Produced by `lambdas/prototype/placement-evening.ts` on 2026-09-17, which replays
scripted evenings through the real placement module. Every host is billed from launch to the end of a ten-minute
drain, including the public address. A 1 GiB system reserve is kept off every host. The last figure in each cell is
the share of starts that landed on a host already up, and so skipped provisioning and the image pull.

| Evening | One host per world (ADR-0048) | Reuse, else launch what fits (ADR-0054 default) | The same, 8 GiB headroom | The same, 16 GiB headroom |
| --- | --- | --- | --- | --- |
| One modded world, three hours | 1 host, $0.38 | 1 host, **$0.38** | 2 hosts, $0.42 | 2 hosts, $0.45 |
| Modded + Factorio + vanilla, overlapping | 3 hosts, $0.96 | 2 hosts, **$0.76**, 33 % warm | 2 hosts, $0.98, 67 % warm | 2 hosts, $1.56, 67 % warm |
| Three modded worlds, overlapping | 3 hosts, $0.90 | 3 hosts, $0.90 | 3 hosts, $1.12, 33 % warm | 2 hosts, $1.56, 67 % warm |
| Stop, then restart six minutes later | 2 hosts, $0.39 | 1 host, **$0.38**, 50 % warm | 3 hosts, $0.46, 50 % warm | 3 hosts, $0.53, 50 % warm |
| Six small servers over an evening | 6 hosts, $1.86 | 2 hosts, **$0.94**, 67 % warm | 2 hosts, $1.26, 83 % warm | 2 hosts, $2.00, 83 % warm |
| Forty servers for many groups, one evening | 40 hosts, $12.81 | 18 hosts, **$7.80**, 55 % warm | 17 hosts, $8.10, 63 % warm | 10 hosts, $8.22, 80 % warm |
| Two hundred servers, one evening | 200 hosts, $61.31 | 67 hosts, **$37.94**, 67 % warm | 67 hosts, $38.03, 67 % warm | 62 hosts, $38.26, 70 % warm |

What the table says:

- **Reuse is the saving, at every size.** Launching only what the footprint needs and reusing what is up never costs
  more than one host per world, costs exactly the same on a one-world evening, and takes about two fifths off an
  evening of many small servers — for one group and for a fleet alike.
- **Packing modded worlds does not pay.** Three 6 GiB footprints would fit one 32 GiB host, but that host costs more
  than the three small ones EC2 answers a 7 GiB request with; on an evening of modded worlds the default and
  one-per-world are the same bill. This is EC2's arithmetic at launch time, not a policy anyone chose.
- **Headroom is a purchase, and the table prices it.** Keeping 16 GiB free on a busy fleet evening moves 80 % of
  starts onto a host already up for about five percent more; on a one-world evening it is a second machine that
  nobody used. That is exactly why it is a setting with a default of zero.
- **The drain costs ten minutes of a host per evening**, about two cents on the small shape. The restart row shows
  what it buys: a stop followed by a start reuses the machine instead of paying for a second.
- **Re-run the replay when the estimates are replaced by API prices.** It changes the numbers in this table; it
  changes nothing in the control plane, which asks EC2 the same question either way.

## What makes it much worse

Each of these is larger than the entire example above.

| Trap | Approximate cost | Avoided by |
| --- | --- | --- |
| NAT Gateway | ~$32 per month, plus data processing | Instance in a public subnet, no private subnet. See [ADR-0032](adr/0032-on-demand-single-instance.md) |
| EKS control plane | ~$73 per month per cluster, before any node; more on extended support | Not using Kubernetes. See [ADR-0014](adr/0014-no-kubernetes.md) |
| An instance that never stopped | 730 h instead of 75, roughly 10x the compute | Idle watchdog, plus a running-hours alarm |
| ~~On-demand instead of Spot~~ | About $8 per month | **Not a trap, a decision.** [ADR-0032](adr/0032-on-demand-single-instance.md) chose on-demand deliberately; [ADR-0027](adr/0027-spot-request-shape.md) records what Spot would cost in machinery |
| An Elastic IP held all month | ~$3.60 per month | DNS record updated on start. See [ADR-0017](adr/0017-stable-server-address.md) |
| Orphaned volumes and snapshots | Silent and cumulative | Terraform owns everything; tag and review monthly |
| Verbose logs with indefinite retention | Grows without limit | Short retention, filtered log shipping |
| Full world archives × retention, **if a world ever grows large** | World size × 9. Harmless at a few hundred MB; a 40 GB world would cost ~$8 a month in backups alone | Watch for a world approaching ~30 GB, then reopen [ADR-0026](adr/0026-tiered-backups.md) |
| An always-on component of any kind | Whatever it costs, forever | Everything is event-driven. This is why there is no hosted bot or proxy |
| Outgrowing the overlay's free tier | Tens of US dollars monthly, several times this whole table | Count what the chosen vendor limits — people or devices — and decide at the cliff, not after. Self-hosted WireGuard is the escape. See [ADR-0024](adr/0024-connectivity-modes.md) |

## The free tier, and a risk it carries

Verified 2026-08-12; AWS restructured this recently, so re-check the terms before relying on it.

| | |
| --- | --- |
| Credits | $100 on opening an account, up to $200 total by completing onboarding activities |
| Credit expiry | Twelve months from opening the account |
| **Free Plan expiry** | **Six months from opening, or when credits run out — whichever is first** |
| Always-free tiers | Still exist, 30+ services with monthly allowances that do not consume credits and never expire |
| Restricted on the Free Plan | Services that burn credits fast — Marketplace, Reserved Instances, Savings Plans, hardware. Confirm the full list against the terms |

**Everything this project needs is available.** The restricted list is things this design already rejected: Reserved
Instances and Savings Plans are the wrong instrument for a workload running 10% of the month, per
[ADR-0032](adr/0032-on-demand-single-instance.md), and nothing here touches Marketplace. EC2, Spot, EBS, S3, Lambda,
Step Functions, SSM, EventBridge, SNS, CloudWatch and Route 53 are all ordinary services.

**Money is not the constraint.** At roughly $6 a month, $200 is over thirty months of runway against credits that expire
in twelve. The design is far too cheap for the credits to be the limiting factor.

### The constraint is the clock, and it threatens the world

The Free Plan **closes at six months**, and after it closes there are 90 days to upgrade to a Paid Plan. After that AWS
**permanently closes the account and deletes its content and resources**.

That is an existential risk to the one thing in this system that cannot be regenerated. This whole design exists to
protect a world with hundreds of hours in it, with backups kept two months deep — and all of it would sit inside an
account with an automatic expiry date, whose deletion is a policy action rather than a failure anyone gets alerted about.

### When to switch, and why not immediately

An earlier version of this section said to move to the Paid Plan straight away. That was too blunt, because the Free
Plan carries one genuinely useful property in the other direction: **it is a hard spend cap.** When the credits are
gone the plan closes, so a runaway — an instance that never stopped, the failure this document keeps returning to —
cannot produce a bill. It just ends the plan. On the Paid Plan the same mistake costs real money.

That property is worth most exactly when it is most likely to be needed: at the start, while the automation is being
built and something is most likely to be left running by accident.

So the trigger is not a date, it is a state:

| Phase | Plan | Why |
| --- | --- | --- |
| **M0** — the manual spike, explicitly throwaway | Free | A hard cap while learning, and nothing in the account is irreplaceable yet. See [docs/roadmap.md](roadmap.md) |
| **M1 onwards** — the real world moves in, backups start mattering | **Paid** | From here, losing the account is losing the world. The cap stops being protection and starts being a deletion timer |

That lands weeks in, not months, so the six-month cliff never becomes something to remember. Set a calendar reminder
anyway as a backstop, because the failure is silent and total.

Switching does not spend more — you still pay only for usage, and the credits still apply. Confirm that last point in
the console when upgrading, since it is your money and this document is not the authority on it.

**And keep one copy of the world outside AWS**, whichever plan you are on. The monthly archive from
[ADR-0010](adr/0010-world-persistence-and-backups.md) downloaded to a machine at home costs nothing, and it is the only
backup that survives losing the account itself. A backup inside the account being deleted is not a backup against the
account being deleted.

Moving to Paid also means the guardrails below stop being good practice and start being the thing standing between a
failed stop and a real bill. They were already required before any long-running resource exists; this is why.

## How bad can the bill get

The useful answer splits in two, and the split is sharper than expected.

### Bounded: everything this design already alarms on

| Failure | A month of it |
| --- | --- |
| Instance never stops | 730 h x $0.03, plus fixed — about **$25** |
| A preview environment left running | Same again, about **$25** |
| The fleet not deleted, so EC2 restarts the instance | Same again |
| A crash loop writing 5 GB of logs a day | 150 GB x ~$0.50 — about **$75**, and retention caps it |

All of it is tens of dollars, all of it is caught by the running-hours alarm within hours rather than at the end of the
month, and none of it is frightening. **The obvious failures in this design are not the expensive ones.**

### Unbounded: the ones that make headlines

Three vectors have no ceiling, and only one of them is really about this project.

**Egress, and it is the design's own doing.** [ADR-0013](adr/0013-modpack-distribution.md) publishes the client pack at
a public URL, on the reasoning that nothing about it is secret. At roughly $0.09 per GB, a 500 MB pack fetched ten
thousand times is five terabytes and **about $450**. Nobody needs to be malicious — a hotlink from a forum, a scraper,
or one person's broken download loop does it. This was the largest genuine exposure in the design, and it was introduced
by a convenience decision rather than by a mistake.

The group's own usage is nothing: five players fetching a 500 MB archive twice a month is under $0.50. **The size was
never the problem; the open URL was.** [ADR-0013](adr/0013-modpack-distribution.md) now closes it with short-lived
signed links issued by the bot.

**A recursive trigger.** The promotion pipeline writes the live pointer, and writing the live pointer is what triggers
the promotion pipeline. That shape is one careless prefix away from a loop, and Step Functions bills per state
transition while Lambda bills per invocation. A loop left running over a weekend is a four-figure bill built out of
fractions of a cent.

**Compromised credentials.** Somebody obtains a key and mines cryptocurrency across every region. This is where the
$50,000 stories come from, and it is not specific to this project — but it is why "no long-lived access keys anywhere,
OIDC for CI" in [ADR-0028](adr/0028-update-proposals.md) matters beyond tidiness.

### What being publicly scanned actually costs

Worth separating from the security question, because the money answer is different and much less alarming.

**Directly: pennies.** A status ping response is a couple of kilobytes. Even twenty thousand of them a month is tens of
megabytes, under a cent. An uninvited player who joins and explores for an hour pulls perhaps a hundred megabytes of
chunk data — about a cent. Being in every Minecraft scanner's index is not, by itself, a cost problem.

**Indirectly: one vector, narrower than it first appears.** The idle watchdog stops the instance when the player count
reaches zero, and **anybody who can join keeps that count above zero** — so a stranger who joins does not merely grief
the world, they hold the server open.

But reaching that state requires more than being scanned, because **only an authorised person can start the server at
all**. See [ADR-0006](adr/0006-on-demand-start-and-idle-shutdown.md). The full chain is: a real player starts a session,
a scanner finds the address *inside* that two-to-three-hour window, the stranger reads a name from the status ping,
joins, and then outstays the real players.

An earlier version of this section said a changing address buys nothing because scanners re-find a server in hours.
That was written for a server that is up continuously. **It is wrong for this one.** Exposure comes in short,
non-contiguous windows on a different address each time, so every session is an independent lottery rather than
cumulative exposure — which makes the rotation worth considerably more than it was credited with.

| | Hours | Monthly |
| --- | --- | --- |
| Intended | 75 | ~$6.85 |
| Watchdog defeated all month | 730 | ~$40 |

So on the money question, the security failure and the cost failure are **the same failure**, reached by a different
route. That is the answer to "what does being indexed cost": not egress, but a watchdog that never fires.

**And it is already bounded.** The running-hours alarm in [ADR-0015](adr/0015-observability-and-alerting.md) exists
precisely for an instance that will not stop, and it fires in hours rather than at the end of the month. A three-hour
session that runs twelve costs about **fifty cents extra**, not thirty dollars. The Budgets action discussed below caps
it harder still.

**Better: bound it by design rather than by alarm.** Sessions are two to three hours. A **hard session cap** — stop
unconditionally after some multiple of that, regardless of who appears to be online — removes the vector rather than
detecting it, and costs the real group nothing because a keep-alive command already needs to exist for mid-session
breaks. See [ADR-0006](adr/0006-on-demand-start-and-idle-shutdown.md). An alarm tells you a stranger is holding the
server; a cap means they cannot hold it for more than a few hours whatever they do.

**Which leads to an honest conclusion.** If the only concern is the bill, a public address is defensible: the direct
cost is negligible and the one real vector is already alarmed and bounded to small change per incident. What a public
address does not protect is the **world** — months of building, against somebody who can log in as any name they read
off the status ping. That is the exposure being accepted, and it is not a financial one.

### What actually caps it, as opposed to noticing it

**An AWS Budgets alarm notifies. It does not stop anything.** As specified so far, the guardrail is a smoke alarm, not a
sprinkler — and against the three unbounded vectors, notification arrives after the money is spent. Budgets also
supports *actions*, which can apply a restrictive policy or stop instances at a threshold; verify the current
capabilities before relying on them. That answers the "cost guardrail response" placeholder in the
[ADR index](adr/README.md): the answer is act, not merely notify.

Concretely, in rough order of how much exposure each removes:

1. **A Budgets action that stops instances and denies expensive APIs** at a threshold well above the expected bill.
2. **Reserved concurrency on every Lambda.** A cap on parallel executions turns a runaway loop from unbounded into a
   known rate.
3. **A pipeline never writes into the prefix that triggers it.** Structural, free, and it removes the loop entirely
   rather than limiting it.
4. **Short-lived signed links for the pack, instead of a public URL.** The group installs mods by hand, so the artefact
   is a 500 MB archive rather than a manifest — and that is fine: five players fetching it twice a month is under $0.50.
   The exposure was never the size, it was the URL being open. A signed link from the bot caps any scrape at the length
   of one link. See [ADR-0013](adr/0013-modpack-distribution.md).
5. **MFA on the root account, and no long-lived keys anywhere.**
6. **Log retention set from the start**, which caps the only bounded-but-annoying case.

### The honest summary

Absent stolen credentials or a scraped public file, the realistic worst case for this design is **tens of dollars, not
thousands** — and the design already alarms on every route to it. The two exposures worth actually engineering against
are the public pack and the self-triggering pipeline, and both are cheap to close.

## Guardrails

In order of when they go in.

1. **AWS Budgets alarm before the first long-running resource exists.** Not after the first surprising bill.
   Notify by chat and email. **Done 2026-08-12:** $20 monthly, alerts at 80% forecasted and 95% actual. Two caveats
   recorded in [the runbook](runbook.md#account-bootstrap): the forecast alert cannot fire until AWS has history for the
   account, and while credits cover the bill on the Free plan the budget may read zero — verify it reports real usage
   once something has run, and filter the charge type if it does not.
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
| **Current Free Plan shape**, EC2 **on-demand `m7i-flex.large`** | **~$12.45 list, credits apply** | — | 2 vCPU / 8 GiB, one-player tested |
| Reviewed paid upgrade, EC2 **on-demand `r8i-flex.large`** | **~$15.79** | — | 2 vCPU / 16 GiB, quoted price |
| The same on Spot, once deferred work is done | ~$7.70 | — | roughly a third of the hourly rate |
| VPS, **dedicated** CPU | ~€7.50 | €16.98 | 2 core / 4 GB — "often enough" |
| VPS, **shared** CPU | ~€10.50 | €23.73 | 4 core / 8 GB |
| VPS, **dedicated** CPU | ~€14.25 | €33.94 | 4 core / 8 GB |
| VPS, **dedicated** CPU | ~€28.50 | €67.86 | 8 core / **16 GB** — the like-for-like row |

**Doubling the memory widens the gap rather than closing it.** Like for like is about $15.79 against €28.50, and
the reason is structural: **the VPS ladder couples cores to memory.** 16 GB is only available on the 8-core
rung, and this workload uses about a fifth of one core. Cloud instance families let you buy the axis that actually
binds — a memory-optimised `.large` is 2 vCPU and 16 GiB — which is the first advantage in this document that is about
shape rather than price.

**A rented box may well have the faster core.** Budget providers often run desktop-class CPUs at high clocks, where
cloud general-purpose families run server parts clocked lower. For a workload whose main tick is single-threaded and
cannot be spread across cores, that is a stronger argument for a rented box than any of the pricing above — and it is
the one argument in this document that money cannot answer. See [ADR-0032](adr/0032-on-demand-single-instance.md).

**Shared CPU is the wrong comparison for a game server.** The main game tick is effectively single-threaded and
latency-sensitive, so contention on an oversubscribed host shows up directly as tick lag — the thing players feel. EC2's
general-purpose families give real vCPUs rather than burstable credits, so the honest comparison is against the
*dedicated* rows.

Read that way the ordering is clear, and it settles an argument this document has now had three times:

**At like-for-like memory the cloud on-demand host is not the expensive option** — it is level with, or cheaper than,
the rented box. The 16 GiB comparison is about **$15.79 against €28.50**, because the VPS ladder only sells 16 GB on its
8-core rung while this workload uses about a fifth of one core. Spot would be cheaper still — around $7.70 — but it is
deferred ([ADR-0027](adr/0027-spot-request-shape.md)), and the model no longer leans on that discount.

So the trade is precise, and it is the opposite of what this document once claimed. A rented box is cheaper **only if
you drop memory or accept a shared CPU** — the €7.50 to €14 rows, all of them 8 GB or less, or oversubscribed. Matched
on memory and given real cores, on-demand EC2 is the cheaper option *and* keeps the on-demand lifecycle. The one thing
the rented box can still offer is a faster single core, discussed above, which is the argument money here cannot settle.

**One measurement now has money attached.** Whether the pack needs 8 GB or 16 GB decides between the €14 and €28 tiers,
and between EC2 sizes. See item 2 in [docs/measurements.md](measurements.md).

Worth knowing where the fork actually is: most of this project is **not** AWS-specific. The release model, the client
packs, the control-plane API, the bots and the linking design would all work against a rented box. What a flat-rate box
removes is exactly the on-demand lifecycle — start, idle stop, interruption handling, connectivity that changes on every
boot — which is the part with the most transferable engineering in it.

### How often Spot actually interrupts

**Retained for the day Spot is reconsidered, not live.**
[ADR-0032](adr/0032-on-demand-single-instance.md) runs on-demand, so nothing in this section is currently in force.
It is kept because re-finding the data costs more than keeping it.

AWS's Spot Instance Advisor reports interruption frequency in bands — under 5%, 5–10%, 10–15%, 15–20%, over 20% — measured
as the rate at which capacity was reclaimed over the trailing month. The historical average across regions and instance
types is **below 5%**, and that figure is for an instance running the whole month. This design runs about a tenth of the
month, so the realistic expectation for a well-chosen type is a handful of interruptions a year, not a weekly event.

An interruption would cost the evening, not data: two minutes of warning, a confirmed world save, a clean stop, and
everybody reconnects after the next start having lost seconds.

**Retracted: "the Spot discount is load-bearing for the whole cost argument."** This document said exactly that while the
model assumed Spot and a compute line of about $4.50. The paid 16 GiB comparison is now about $15.79 all in at 75
hours; the current 8 GiB Free Plan shape is about $12.45 at list rates before credits. The discount is worth having
eventually; it is not what the argument stands on.

If Spot is ever adopted, two things from that earlier reasoning survive and are worth keeping: check the Advisor for the
specific candidate types **before** committing to a region, and allow several instance types rather than one. The zonal
EBS volume limits the choice to types within a single zone, which is the residual risk recorded in
[ADR-0027](adr/0027-spot-request-shape.md).

So the design pays for itself in the other currency. Stopping when idle, separating state from compute, a release
pipeline with rollback, orchestration, cost guardrails — those are the deliverable.
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

- [x] Region choice: `eu-central-1`; Spot is deferred, so its price history is not an M0 input.
- [x] Current public IPv4 hourly rate: $0.005, verified 2026-08-13.
- [x] gp3 rate in the chosen region: $0.0952/GB-month; measured data fits the chosen 20 GB volume.
- [ ] Free-tier allowances currently applying to this account for Lambda, CloudFront and data transfer.
- [ ] Colder storage class for backups older than a month, and its retrieval cost.
- [x] The monthly Budgets figure: $20, configured and delivery-tested through SNS on 2026-08-13.
- [ ] Head count and device count for the actual group, which decides which overlay vendor's free tier fits. See
      [ADR-0024](adr/0024-connectivity-modes.md).
- [ ] Whether a player given access as a *shared device* counts towards Tailscale's 6-user limit, if that vendor is
      chosen after all.
- [x] Real initial world and pack sizes are recorded in [measurements](measurements.md); 20 GB is the M0 data volume.
