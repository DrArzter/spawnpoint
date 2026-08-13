# Runbook

**Work in progress.** M1 infrastructure is live; procedures still marked `TODO` belong to later automation milestones.

Fill each section in the milestone that builds it, and record the date each procedure was last actually
performed. A procedure nobody has run is a guess.

| Procedure | Owner | Last performed |
| --- | --- | --- |
| Start the server | Any player | 2026-08-14 — M2 Standard Workflow started stopped EC2, waited for SSM, invoked the host session contract and returned the private address |
| Stop the server | Owner; M2 automation pending | 2026-08-14 — 0 players confirmed, world flushed, all session containers stopped, post-session archive verified in S3, EC2 reached `stopped` |
| Promote a release | Owner | — |
| Roll back a release | Owner | — |
| Restore the world | Owner | 2026-08-13 — the Terraform M1 host downloaded the verified S3 archive with its instance role, restored it onto a new EBS, reconciled release 1.0 and accepted a player in the recovered world |
| Recover from a lost instance | Owner | — |
| Bootstrap Terraform state | Owner | 2026-08-13 — bucket created by saved plan, controls verified through S3 API, native lock exercised, final drift check clean |
| Tear down and rebuild | Owner | — |
| Monthly cost check | Owner | — |

## Reference

Fill in at M1 and keep current. This block is what somebody needs when something is broken.

| Item | Value |
| --- | --- |
| AWS account | Resolve with `aws sts get-caller-identity`; do not hard-code it |
| Region | `eu-central-1` — see [ADR-0002](adr/0002-host-on-aws.md) |
| Terraform state bucket | `spawnpoint-tfstate-614934752397` |
| Server hostname | TODO |
| Instance ID / tag | `i-09c9b5069308ac372` / `spawnpoint-game-host` (Terraform M1) |
| Data volume ID | `vol-01bcd86ae27b55682`, encrypted 20 GiB gp3, `DeleteOnTermination=false`, `eu-central-1a` |
| Release bucket | `spawnpoint-releases-614934752397` |
| Backup bucket | `spawnpoint-backups-614934752397` |
| Panel URL | Grafana at `http://172.29.23.24:3000` inside ZeroTier |
| Container image | `itzg/minecraft-server` pinned by digest in `server/compose.yaml`, never `latest` |
| Minecraft and loader version | Minecraft 1.20.1, Forge, immutable release `1.0` with 111 JARs |

## Start the server

Current M2 path from an authenticated owner workstation:

```bash
scripts/start-server.sh
```

It starts the durable workflow and follows it until terminal state. Add `--no-follow` to return immediately with the
execution ARN. A second call while an execution is still running joins it rather than starting another one.

Future normal path: press **Start** in the panel, or send `start` to the bot. Those surfaces will call the same state
machine rather than reproduce its EC2/SSM sequence.

Break-glass owner path, only when the workflow itself is unavailable:

```bash
aws ec2 start-instances \
  --instance-ids i-09c9b5069308ac372 \
  --profile spawnpoint \
  --region eu-central-1
```

Do not treat EC2 `running` as game readiness. The workflow checks SSM, the authorised ZeroTier identity and the host
Minecraft health contract before returning `172.29.23.24:25565`.

```bash
# TODO: dig +short <hostname>
```

**If the start operation never reaches ready:** inspect its Step Functions execution history. It separates EC2 start,
SSM registration and the host command, so the failed boundary is visible. See [failure modes](architecture.md#failure-modes).

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
2. List available S3 archives:

   ```bash
   aws s3api list-objects-v2 \
     --bucket spawnpoint-backups-614934752397 \
     --prefix worlds/world/archives/ \
     --profile spawnpoint \
     --region eu-central-1
   ```
3. Choose one, and check its date against when the damage was noticed — the most recent archive may already
   contain the corruption.
4. Restore into a new volume or path, never over the live world:

   ```bash
   AWS_PROFILE=spawnpoint AWS_REGION=eu-central-1 \
   BACKUP_BUCKET=spawnpoint-backups-614934752397 \
     server/scripts/download-world-backup.sh <object-key> /tmp/world-from-s3.tar.zst

   server/scripts/verify-archive.sh /tmp/world-from-s3.tar.zst
   server/scripts/restore-world.sh /tmp/world-from-s3.tar.zst <new-empty-data-directory>
   ```
5. Start the server and verify in game.
6. Record in the table above what was restored, from when, and how long it took.

The restored world must be paired with the exact release that created it before Minecraft starts. In particular, do
not combine `REMOVE_OLD_MODS=true` with an absent or empty desired-mod list: the image will correctly reconcile the
directory to an empty set, and Forge will then reject dimensions belonging to the missing mods. The 2026-08-12 drill
reproduced this failure and succeeded after restoring all 111 JARs and disabling reconciliation for the smoke test.
Production restore must use the immutable release artefact rather than copying a mutable mod directory.

The first 2026-08-13 S3 drill downloaded
`worlds/world/archives/world-20260812T201024Z-e3909da890fa9a79364617bd4feb1f4c095cc519c1778918cfa6a85403252e87.tar.zst`,
verified all three stored facts (metadata digest, S3 checksum and byte length), extracted it and found no content
differences from the stopped source world. The first off-volume backup is therefore tested, not merely listable.

The Terraform M1 host then performed the production-shaped half of the drill: its EC2 instance role downloaded that
same object, verified the stored checksum and restored **635,666,233 bytes** onto the new EBS volume. It independently
downloaded immutable release `1.0`, reconciled all **111 JARs / 623,534,143 bytes**, and only then moved the restored
world into the live data directory. See [the M1 command log](aws-m1-command-log.md).

## Recover from a lost instance

Ordinary case: the volume survived. Start a new instance from Terraform and reattach.

```bash
# TODO: terraform apply
```

Volume lost as well: create a volume, restore from the newest verified archive, then apply.

Availability zone unavailable: the volume is zonal, so a zone change means restore rather than reattach.
See [ADR-0032](adr/0032-on-demand-single-instance.md).

## Break glass: SSM is not working

There is no SSH port and no key pair, by design. See [ADR-0007](adr/0007-ssm-instead-of-ssh.md). If the
instance is unreachable through SSM:

1. Do not add an SSH port to the security group. That is a permanent change made under pressure.
2. Check the agent status and the instance profile first — a missing permission is the usual cause.
3. If the agent is genuinely broken, replace the instance. The world is on a separate volume, so
   replacement is the cheaper path than getting a shell.

## Account bootstrap

One-time, manual, and done before anything else exists. Recorded here because Terraform does not know about any of it.

**The procedure, with its traps, is [docs/aws-account-checklist.md](aws-account-checklist.md).** This section records
what was actually done in *this* account.

Progress as of 2026-08-13: root and IAM-user MFA, billing access, IAM user and group, budget, SNS topic, confirmed email
subscription, budget-to-SNS delivery configuration, anomaly retune and the Availability Zone decision are done. The
cost allocation tag still has to be activated once a tagged billable resource makes it appear in Billing. The
read-only account checks live in [docs/aws-cli-checks.md](aws-cli-checks.md); the infrastructure execution logs are
[M0](aws-m0-command-log.md), [M1](aws-m1-command-log.md) and [M2](aws-m2-command-log.md).

Record here what was actually created:

| Item | Value |
| --- | --- |
| Administrative identity | IAM user `drarzter`, in group `admin`, with `AdministratorAccess`, virtual MFA and no access key; verified through the IAM API on 2026-08-13 |
| IAM Identity Center | **Deliberately not enabled.** Deferred to M1 — enabling it expires the free tier credits immediately |
| Account plan | **Free**, as of 2026-08-12. Keep the eligible `m7i-flex.large` while credits last; preserve an external world copy and move to Paid before expiry or a 16 GiB upgrade — see [docs/costs.md](costs.md) |
| Budget | **$20/month, fixed, all services, unblended.** Created 2026-08-12 |
| Budget alerts | 80% **forecasted** ($16) and 95% **actual** ($19), both publishing to `spawnpoint-alert`; verified through the Budgets API on 2026-08-13 |
| Cost anomaly monitor | **Default-Services-Monitor**, created by AWS, all services |
| Cost anomaly subscription | **Retuned** from the AWS default of `$100 AND 40%`, which could never fire on a ~$15 account. Now **$5 AND 40%**, individual alerts, delivered via SNS |
| SNS alert topic | `arn:aws:sns:eu-central-1:<account-id>:spawnpoint-alert` — Standard, with one confirmed email subscription. The account ID and email are deliberately not written here; query them through the CLI |
| Project tag | `Project=spawnpoint`; M0 also uses `Environment=m0` and `ManagedBy=manual` |
| Chosen Availability Zone | `eu-central-1a`, physical Zone ID `euc1-az2`; `m7i-flex.large`, `r8i-flex.large` and a public subnet were verified there on 2026-08-13 |
| M0 EC2 identity | IAM role and instance profile `spawnpoint-m0-ec2`; role trusts EC2 and has only `AmazonSSMManagedInstanceCore` attached |
| M0 security group | `spawnpoint-m0-minecraft` in the default VPC; no inbound rules yet, therefore neither Minecraft nor SSH is exposed |
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

The chicken-and-egg step, performed once from a separate Terraform root. It has local state because the S3 bucket
cannot contain the state that creates that same bucket before it exists. Run every command from the repository root.

First authenticate and run the checks. `plan` is read-only; inspect its proposed bucket name and seven resources before
allowing the apply:

```bash
aws sso login --profile spawnpoint

docker run --rm --user "$(id -u):$(id -g)" \
  -e HOME=/tmp/terraform-home \
  -v "$PWD:/workspace" \
  -w /workspace/infra/terraform-bootstrap \
  hashicorp/terraform:1.15.8 init -backend=false

docker run --rm --user "$(id -u):$(id -g)" \
  -e HOME=/tmp/terraform-home \
  -v "$PWD:/workspace" \
  -w /workspace/infra/terraform-bootstrap \
  hashicorp/terraform:1.15.8 plan -out=tfplan
```

Only after the plan has been reviewed, create exactly what it contains:

```bash
docker run --rm --user "$(id -u):$(id -g)" \
  -e HOME=/tmp/terraform-home \
  -v "$PWD:/workspace" \
  -w /workspace/infra/terraform-bootstrap \
  hashicorp/terraform:1.15.8 apply tfplan

docker run --rm --user "$(id -u):$(id -g)" \
  -e HOME=/tmp/terraform-home \
  -v "$PWD:/workspace" \
  -w /workspace/infra/terraform-bootstrap \
  hashicorp/terraform:1.15.8 output -raw state_bucket_name
```

Copy `infra/terraform/backend.hcl.example` to the ignored `infra/terraform/backend.hcl`, replace the placeholder with
that output, then initialise the production root:

```bash
cp infra/terraform/backend.hcl.example infra/terraform/backend.hcl
${EDITOR:-vi} infra/terraform/backend.hcl

docker run --rm --user "$(id -u):$(id -g)" \
  -e HOME=/tmp/terraform-home \
  -v "$PWD:/workspace" \
  -w /workspace/infra/terraform \
  hashicorp/terraform:1.15.8 init -backend-config=backend.hcl
```

`use_lockfile = true` in `backend.hcl` enables S3-native state locking. It is not a permanent AWS resource and needs
no DynamoDB table: Terraform creates a temporary `.tflock` object while an operation owns the lock.

Verify the actual controls, replacing `<bucket>` with the output above. These reads confirm versioning, all four public
access blocks, default encryption and the bucket-level public status:

```bash
aws s3api get-bucket-versioning --bucket <bucket> --profile spawnpoint
aws s3api get-public-access-block --bucket <bucket> --profile spawnpoint
aws s3api get-bucket-encryption --bucket <bucket> --profile spawnpoint
aws s3api get-bucket-policy-status --bucket <bucket> --profile spawnpoint
```

Record the created bucket name in the reference table. Keep a private copy of the ignored bootstrap state until a
restore/import of that state has been tested. The bucket has `prevent_destroy`; never weaken it during ordinary cleanup.

**Performed 2026-08-13.** Terraform created `spawnpoint-tfstate-614934752397`; versioning, SSE-S3, owner enforcement,
all four public-access blocks, non-public policy status and the TLS-only policy were verified through `s3api`. A real
production-root plan exercised S3-native locking. Because bucket versioning also versions short-lived `.tflock`
objects, a narrow lifecycle rule now expires obsolete lock versions after one day without expiring any state version.
The final bootstrap plan reported `No changes`.

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
