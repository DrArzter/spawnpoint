# Runbook

**Skeleton.** Nothing here is deployed yet, so every command is a placeholder marked `TODO`. The headings
are the useful part: they are the list of procedures that must exist, written before the system does, so
none is discovered as missing during an incident.

Fill each section in the milestone that builds it, and record the date each procedure was last actually
performed. A procedure nobody has run is a guess.

| Procedure | Owner | Last performed |
| --- | --- | --- |
| Start the server | Any player | — |
| Stop the server | Automatic | — |
| Promote a release | Owner | — |
| Roll back a release | Owner | — |
| Restore the world | Owner | 2026-08-12 — local archive drill; content-identical restore into `/tmp`, then successful isolated boot with 111 mods, health check and RCON; not yet restored from S3 |
| Recover from a lost instance | Owner | — |
| Bootstrap Terraform state | Owner | — |
| Tear down and rebuild | Owner | — |
| Monthly cost check | Owner | — |

## Reference

Fill in at M1 and keep current. This block is what somebody needs when something is broken.

| Item | Value |
| --- | --- |
| AWS account | TODO |
| Region | TODO — see [ADR-0002](adr/0002-host-on-aws.md) |
| Server hostname | TODO |
| Instance ID / tag | TODO |
| Data volume ID | TODO |
| Release bucket | TODO |
| Backup bucket | TODO |
| Panel URL | TODO |
| Container image tag | TODO — pinned, never `latest` |
| Minecraft and loader version | TODO |

## Start the server

Normal path: press **Start** in the panel, or send `start` to either bot.

Owner path, when the surfaces are unavailable:

```bash
# TODO: aws ec2 start-instances --instance-ids <id> --region <region>
```

Then confirm the hostname resolves to the new address, because the server being up and the server being
reachable by name are different things.

```bash
# TODO: dig +short <hostname>
```

**If the start operation never reaches ready:** check, in this order — Spot capacity (did the instance
actually start), the DNS record, the container. See [failure modes](architecture.md#failure-modes).

## Stop the server

Normally automatic, after N empty player-count readings. To stop it early:

```bash
# TODO: control-plane call, or aws ec2 stop-instances
```

Never stop the instance without a confirmed world save first. The stop path in the automation does this;
a manual stop must do it too.

## Promote a release

1. Cut the release: `# TODO: scripts/cut-release.sh <version>`
2. Verify the manifest: `# TODO`
3. Promote: `# TODO`
4. Watch the operation to *ready*, or to *failed* and an automatic rollback.

Do not promote during an active session unless it is urgent. Announce first.

## Roll back a release

Automatic on a failed start. To roll back manually:

```bash
# TODO: promote the previous version — the pointer move is the rollback
```

Rollback is the same mechanism as a deploy, which is why it can be trusted. See
[ADR-0008](adr/0008-versioned-mod-releases.md).

## Restore the world

Practise this before it is needed. M1 includes a drill.

1. Stop the server, and confirm it is stopped.
2. List available archives: `ls -lh server/backups/*.tar.zst`
3. Choose one, and check its date against when the damage was noticed — the most recent archive may already
   contain the corruption.
4. Restore into a new volume or path, never over the live world:

   ```bash
   server/scripts/verify-archive.sh <archive.tar.zst>
   server/scripts/restore-world.sh <archive.tar.zst> <new-empty-data-directory>
   ```
5. Start the server and verify in game.
6. Record in the table above what was restored, from when, and how long it took.

The restored world must be paired with the exact release that created it before Minecraft starts. In particular, do
not combine `REMOVE_OLD_MODS=true` with an absent or empty desired-mod list: the image will correctly reconcile the
directory to an empty set, and Forge will then reject dimensions belonging to the missing mods. The 2026-08-12 drill
reproduced this failure and succeeded after restoring all 111 JARs and disabling reconciliation for the smoke test.
Production restore must use the immutable release artefact rather than copying a mutable mod directory.

## Recover from a lost instance

Ordinary case: the volume survived. Start a new instance from Terraform and reattach.

```bash
# TODO: terraform apply
```

Volume lost as well: create a volume, restore from the newest verified archive, then apply.

Availability zone unavailable: the volume is zonal, so a zone change means restore rather than reattach.
See [ADR-0004](adr/0004-ec2-spot-for-the-game-server.md).

## Break glass: SSM is not working

There is no SSH port and no key pair, by design. See [ADR-0007](adr/0007-ssm-instead-of-ssh.md). If the
instance is unreachable through SSM:

1. Do not add an SSH port to the security group. That is a permanent change made under pressure.
2. Check the agent status and the instance profile first — a missing permission is the usual cause.
3. If the agent is genuinely broken, replace the instance. The world is on a separate volume, so
   replacement is the cheaper path than getting a shell.

## Account bootstrap

One-time, manual, and done before anything else exists. Recorded here because Terraform does not know about any of it.

**Order matters.** Steps 1–3 are done as root, and step 2 is the one that is easy to miss.

1. **MFA on the root user.** Account menu → Security credentials → assign an MFA device. Then check there are no root
   access keys; a new account should have none, and if any exist, delete them.
2. **Activate IAM access to billing.** Account settings → *IAM user and role access to billing information* → Activate.
   **Only root can do this**, and without it the administrative identity created below cannot see Cost Explorer or
   create the Budgets alarm — which is the next thing it needs to do.
3. **Create a plain IAM user with `AdministratorAccess` and MFA.** Not IAM Identity Center — see the warning below.

   IAM → Users → Create user → tick *Provide user access to the AWS Management Console* → set a password → attach the
   `AdministratorAccess` policy → create. Sign in as that user and enable MFA on it.

   **Do not create an access key.** M0 is console work, so none is needed, and by M1 there will be a better option.

> **Do not enable IAM Identity Center yet.** It is the better long-term answer — short-lived credentials, no access
> keys, and it matches the posture in [ADR-0028](adr/0028-update-proposals.md). But enabling it creates an AWS
> Organization, and the console warns that this **upgrades the account from the free plan to pay-as-you-go and expires
> the free tier credits immediately**. That is $100–200 of credits, roughly a year of running at the modelled ~$15 a
> month, traded for a nicer sign-in.
>
> An *account instance* of Identity Center avoids the Organization but cannot grant console access to AWS accounts —
> checked against the documentation, it is limited to AWS managed applications. So it does not help.
>
> **Do it at M1**, where [docs/costs.md](costs.md) already plans the move to the Paid plan. The upgrade then rides
> along with a transition that is happening anyway, and Terraform can use `aws configure sso` — meaning no long-lived
> access key is ever created.

4. **Create the Budgets alarm**, around $20. See [docs/costs.md](costs.md).
5. **Stop using root.** Keep its credentials somewhere safe: a few things still require it — closing the account,
   changing the support plan, and some billing settings — but nothing in day-to-day work does.

Record here what was actually created:

| Item | Value |
| --- | --- |
| Administrative identity | TODO — plain IAM user with `AdministratorAccess` and MFA, no access key |
| IAM Identity Center | **Deliberately not enabled.** Deferred to M1 — enabling it expires the free tier credits immediately |
| Account plan | **Free**, as of 2026-08-12. Move to Paid before M1 — see [docs/costs.md](costs.md) |
| Budget | **$20/month, fixed, all services, unblended.** Created 2026-08-12 |
| Budget alerts | 80% **forecasted** ($16) and 95% **actual** ($19), both to a `+aws` alias |
| Cost anomaly monitor | **Default-Services-Monitor**, created by AWS, all services |
| Cost anomaly subscription | **Retuned** from the AWS default of `$100 AND 40%`, which could never fire on a ~$15 account. Now **$5 AND 40%**, individual alerts, delivered via SNS |
| SNS alert topic | `arn:aws:sns:eu-central-1:<account-id>:spawnpoint-alert` — Standard. The account ID is deliberately not written here; read it from the console |
| Chosen Availability Zone | TODO — binds every later launch, because the data volume is zonal |
| Cost allocation tag activated | TODO — **activate as soon as the first tagged resource exists.** [ADR-0002](adr/0002-host-on-aws.md) commits to a project tag; a cost allocation tag has to be activated in the billing console before it appears in cost data, and activation is **not retroactive**. Leave it and the early months have no per-project breakdown, permanently |

**The SNS topic is the convergence point** that [ADR-0020](adr/0020-email-channel.md) and
[ADR-0015](adr/0015-observability-and-alerting.md) describe: anomaly alerts publish to it now, budget alerts should be
pointed at it too, and the chat adapters subscribe to it later without either console page being touched again.

Each publisher needs its own statement on the topic policy, because each is a different service principal:
`costalerts.amazonaws.com` for anomaly detection, `budgets.amazonaws.com` for Budgets. Both with an
`aws:SourceAccount` condition, which restricts the grant to operations performed on behalf of this account.

**To tighten at M1**, when Terraform owns the topic: the default statement AWS generates allows `AWS: "*"` — scoped by
source account, but including `SNS:DeleteTopic`, `SNS:AddPermission` and `SNS:RemovePermission`. Acceptable on a
personal account, not least privilege. Narrow it to publish for the two services and subscribe for the owner.

**Budget actions are deferred to M1.** AWS Budgets can *act* rather than notify — stop EC2 instances at a threshold —
which is what the cost-guardrail placeholder in the [ADR index](adr/README.md) leans towards. Not done now for three
reasons: there is nothing to stop yet; it needs a purpose-built IAM role trusting `budgets.amazonaws.com` with
`ec2:StopInstances`, which Terraform should create scoped to the project tag; and it must be attached to an **actual**
threshold rather than a forecasted one. An action on a forecast would stop the server mid-session because the month was
busy.

### Which guardrails are actually live

As of 2026-08-12, one of five. The rest switch on by themselves as history accumulates, or arrive with later milestones.

| Guardrail | Live? |
| --- | --- |
| Budget, 95% actual ($19) | **Yes** |
| Budget, 80% forecasted ($16) | No — AWS cannot forecast a new account |
| Cost anomaly detection | No — needs about ten days to build a baseline |
| Running-hours alarm, [ADR-0015](adr/0015-observability-and-alerting.md) | Not built |
| Budget action that stops instances | Deferred to M1 |

**Two things the budget does not yet cover, both temporary.**

**The forecast alert is inert until there is history.** AWS cannot forecast a new account, so for the first weeks only
the 95% actual alert works. That is the period when something is most likely to be left running by accident.

**So the practical exposure during M0 is about $19 and four to five days.** At $0.16758 an hour, $19 is roughly 110
running hours, which is how long a forgotten instance would run before an email arrives. Until the running-hours alarm
from [ADR-0015](adr/0015-observability-and-alerting.md) exists, the real guardrail is the habit of checking the console
after a session.

**Retune the budget once the bill is real.** $16 is 80% of $20 and the modelled spend is $15.55, so once the design is
actually running the forecast alert becomes noise. Move the budget to about $30 then, and keep the alerts where they
are.

## Bootstrap Terraform state

The chicken-and-egg step, done once by hand and therefore easy to forget.

1. Create the state bucket, with versioning on: `# TODO`
2. Enable locking: `# TODO`
3. `terraform init` with the backend configuration: `# TODO`

Record here exactly what was created by hand, because Terraform does not know about it.

## Tear down and rebuild

For a season when nobody plays. Keeps the backups, drops the running cost to almost nothing.

1. Final archive, and verify it: `# TODO`
2. Confirm the archive is listable and the right size.
3. `terraform destroy`
4. Confirm in the console that volumes and snapshots are gone — orphans are the usual leftover.
5. To come back: `terraform apply`, then restore the world.

## Monthly cost check

Five minutes, and it is how orphaned resources are found.

1. Cost Explorer, grouped by service, this month against last.
2. Compare against [docs/costs.md](costs.md), and update the model if reality disagrees.
3. Look for anything billed while nobody played — that is either a fixed cost that was not planned, or an
   orphan.
4. Confirm the Budgets alarm threshold is still sensible.

## When an alarm fires

| Alarm | First check |
| --- | --- |
| Running hours exceeded | Did the idle watchdog run at all? Is a player genuinely online? |
| Container restart loop | Which release is live? Was it just promoted? Roll back |
| Backup failed | Was the world saved? Is the bucket policy intact? Re-run before the next session |
| Volume nearly full | World growth, or log growth? Prune logs first |
| Budgets threshold | Cost Explorer by service. Look for an always-on resource that should not exist |
