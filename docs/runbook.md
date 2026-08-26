# Runbook

**Work in progress.** M1 infrastructure is live; procedures still marked `TODO` belong to later automation milestones.

Fill each section in the milestone that builds it, and record the date each procedure was last actually
performed. A procedure nobody has run is a guess.

| Procedure | Owner | Last performed |
| --- | --- | --- |
| Start the server | Any player | 2026-08-14 — M2 Standard Workflow started stopped EC2, waited for SSM, invoked the host session contract and returned the private address |
| Stop the server | Owner | 2026-08-14 — M2 Standard Workflow rechecked 0 players, flushed the world, stopped all session containers, verified an immutable S3 backup and only then stopped EC2 |
| Promote a release | Owner | — |
| Adopt the existing world | Owner | 2026-08-26 — verified all 111 installed JARs against immutable release 1.0, then atomically created desired=active=1.0 without starting Minecraft |
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

Current M2 owner path:

```bash
scripts/stop-server.sh
```

The command asks for confirmation and follows the durable operation. Use `--no-follow` to return after receiving its
execution ARN; automation must additionally pass `--yes`. The host refuses to stop while a player is online. With zero
players it performs `save-all flush`, stops every session container, creates a full archive, uploads it under an
immutable checksum-addressed S3 key and verifies the stored metadata before Step Functions may stop EC2.

Never replace this with a direct `aws ec2 stop-instances` during normal operation: that bypasses the save and backup
contract.

### Idle watchdog

**Deployed, not yet acceptance-tested.** `spawnpoint-idle-watchdog` is a Standard workflow started by
`scripts/start-server.sh` alongside every session — one execution per session, nothing scheduled, nothing running
between sessions. It probes `idle-probe.sh` over SSM every 5 minutes; three consecutive empty readings (15 min) start
the verified stop above. A failed probe never counts as empty. The hard session cap is 96 checks (8 h), and stops the
host regardless of the player count. See [workflows/README.md](../workflows/README.md).

To deploy it without touching EC2/EBS: review and apply `infra/terraform-operations`. The root also contains promotion;
creating either state machine does not start an execution. The running-hours alarm remains in the host root. Validate
the definition first, read-only:

```bash
aws stepfunctions validate-state-machine-definition --definition file://workflows/idle-watchdog.asl.json --type STANDARD --severity WARNING --profile spawnpoint --region eu-central-1
```

Acceptance drill, one evening: start a session with the watchdog input's `checkIntervalSeconds` at 60 and
`emptyChecksRequired` at 2, join, leave, and watch the execution stop the host within ~3 minutes. Then record the date
in the procedure table. If the watchdog itself fails, its execution failure is the signal —
`Spawnpoint.WatchdogBlind` means the host was unobservable and was deliberately left running; the
`spawnpoint-running-hours` alarm (10 consecutive hours → `spawnpoint-alerts`) and the budget are the backstops.

## Telegram bot

**Built, not yet applied or acceptance-tested.** `start`, `status`, `pack` — the M4 cut. One-time setup, in order:

1. Create the bot with @BotFather, keep the token.
2. Put the three parameters in Parameter Store (the only hand-made secrets in the system):

```bash
aws ssm put-parameter --name /spawnpoint/bot/token --type SecureString --value '<botfather token>' --profile spawnpoint --region eu-central-1
aws ssm put-parameter --name /spawnpoint/bot/webhook-secret --type SecureString --value "$(openssl rand -hex 32)" --profile spawnpoint --region eu-central-1
aws ssm put-parameter --name /spawnpoint/bot/allow-list --type String --value '<id1>,<id2>' --profile spawnpoint --region eu-central-1
aws ssm put-parameter --name /spawnpoint/bot/chat-ids --type String --value '<group id>,<dm id>,...' --profile spawnpoint --region eu-central-1
```

   Telegram user ids are numbers; each player gets theirs from @userinfobot. Editing the allow-list is
   `put-parameter --overwrite` — no deploy.
3. Build and apply: `cd lambdas && npm install && npm run build`, then `terraform apply` in `infra/terraform`.
4. Register the webhook, pointing Telegram at the `bot_webhook_url` output with the same secret:

```bash
curl -s "https://api.telegram.org/bot<token>/setWebhook" -d "url=<bot_webhook_url>" -d "secret_token=<webhook-secret value>"
```

The bot works in the group and in direct messages alike — commands answer wherever they were asked, and the
allow-list is by user, not by chat. One platform rule to know: **a bot can never write to a person first.** A player
who wants the bot in DMs (or a DM notification target) opens the bot once and presses Start; until then that DM does
not exist for the bot. Notification targets are the `chat-ids` list — group ids are negative, DM ids positive, edit
with `put-parameter --overwrite`, takes effect within a minute. One unreachable target never blocks the rest.

Guardrail alerts arrive in the same chat: the notifier is subscribed to `spawnpoint-alerts`, so the budget, cost
anomalies and the running-hours alarm all speak Telegram — and email on the same topic remains the out-of-band path
that works even when the notifier does not (ADR-0020). An unrecognised alert format is delivered raw rather than
dropped.

Notifications need no wiring beyond the `chat-ids` parameter: Step Functions publishes every execution's status
changes to EventBridge on its own, and the `spawnpoint-notifier` function turns the meaningful ones into group
messages — requested (with who asked), ready (with the address), stopped by the watchdog, promoted, rolled back, and
every failed stop, because a failed stop is the backup contract failing. Child executions stay silent by design, so
nothing is announced twice. The group chat id: add the bot to the group, send a message, read `chat.id` from
`getUpdates` (a negative number for groups).

Acceptance: from a phone on the allow-list, `/status` answers, `/start` brings the server up — the group sees
"requested" and "ready" arrive on their own — and `/pack` returns a working link whose zip carries INSTALL.txt. From a
phone not on the list, every command is politely denied. Leave, and the watchdog's stop announces itself. That is
M4's done-when.

## Import a world

Bring an existing world and the exact mods it runs on into the system, from the owner workstation:

```bash
scripts/import-world.sh <data-dir> <world-name> <mods-dir> <release> <minecraft-version> <loader-version>
```

Five steps, in an order where a failure never leaves a half-imported world looking whole: build the manifest → publish
the release (mods first, manifest last) → archive the world → upload the verified archive → write the world's release
pointer `worlds/<name>/release.json`. The pointer is **ADR-0030's document in its first real form**: `desired_release`
set to what was imported, `active_release` null until a start passes the health check.

- Importing a second world on the same pack is normal: the release upload reports `already_present`.
- Re-importing an existing world is refused: changing its release is a promotion, not an import.
- The same release version with different mod bytes is refused: releases are immutable.

**Wired on the code side, pending apply.** `start-session.sh` now performs boot-time reconciliation: it reads the
world's pointer, ensures a verified local copy of the desired release (a cache on the data volume — an unchanged boot
downloads nothing, a tampered cache heals itself), and atomically reconciles the live mod directory before Minecraft
starts. No pointer means the pre-import legacy path; any other failure refuses the start, because wrong mods corrupt
worlds. The host's IAM policy gains read access to `worlds/*` in the same Terraform change — apply it together with
the watchdog slice. The host `.env` must carry `RELEASE_BUCKET` (and optionally `WORLD_NAME`) for the pointer path to
activate.

## Promote a release

**Promotion is deployed from `infra/terraform-operations`, not yet acceptance-tested.** Release construction has moved off the owner workstation:
the GitHub Action, narrow AWS OIDC role, CodeBuild project and its Standard Workflow are deployed. The infrastructure
is idle between builds and post-apply plans are clean. Release `1.1` completed the first end-to-end acceptance run:
GitHub OIDC → Step Functions → CodeBuild → 111 hashed JARs → manifest-last S3 publication, without starting EC2 or
changing a world pointer. See [the M3 command log](aws-m3-command-log.md).

One-time secret setup, without putting the key value in shell history:

```bash
read -rsp 'CurseForge API key: ' CF_KEY && printf '\n'
printf '%s' "$CF_KEY" | aws ssm put-parameter \
  --name /spawnpoint/releases/curseforge-api-key \
  --type SecureString \
  --value file:///dev/stdin \
  --profile spawnpoint \
  --region eu-central-1
unset CF_KEY
```

The intended production sequence is:

1. GitHub Actions passes the profile ID, exact configuration commit and new release version to the AWS workflow through
   OIDC. It never receives the CurseForge key and never downloads a mod.
2. CodeBuild resolves the clean profile checkout, builds the exact manifest, uploads JARs first and the manifest last.
   The resulting candidate is inert: no pointer changes and no server starts.
3. Promote it: `scripts/promote-release.sh <world> <version>` — writes desired, runs the verified stop and start
   (boot-time reconciliation applies the release, the health gate proves it), commits active, and relaunches the
   watchdog if the server was running. A stopped server is stopped again afterwards.
4. A failed start rolls back by itself: the pointer flips to the previous active and the server starts again on it.
   `status=rolled_back` in the output is the pipeline working, not failing.

`scripts/cut-release.sh` remains only a manual bootstrap/diagnostic path. The accepted production contract is the
GitHub-to-AWS builder above, and the game host never resolves CurseForge on boot.

Do not promote during an active session unless it is urgent — the stop refuses while players are online
(`PromotionRefused`, pointer restored, nothing changed). Announce first.

If it ends `RollbackFailed`, `PromotedButRunning` or `RolledBackButRunning`: the pointer tells the truth about what
should be running, the execution history says where it stopped, and the running-hours alarm is the cost backstop.

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
| M0 EC2 identity | Retired 2026-08-15: manual instance terminated, root and data EBS deleted, IAM role/profile deleted |
| M0 security group | Retired 2026-08-15: `spawnpoint-m0-minecraft` deleted after its ENI dependency audit returned empty |
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
