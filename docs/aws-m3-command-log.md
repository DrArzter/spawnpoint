# AWS M3 command log

Work started on 2026-08-25 with profile `spawnpoint` in `eu-central-1`. This log records commands actually run and
separates local verification, plans and applies. A plan is not evidence that a resource exists.

## GitHub-triggered builder: code and plans

The first version placed CodeBuild and `spawnpoint-build-release` in the disposable host root. Before any apply, a
production plan exposed the coupling:

```bash
terraform -chdir=infra/terraform plan -lock-timeout=30s -no-color
```

Result: **28 add / 4 change / 2 destroy**, including replacement of `aws_instance.game_host` and
`aws_volume_attachment.data`; the plan then stopped because code expects the not-yet-adopted SNS topic
`spawnpoint-alerts`, while the manually created topic is named `spawnpoint-alert`. Nothing from that plan was applied.

Release construction does not use the host, so the builder and its Standard Workflow were moved to
`infra/terraform-releases` with state key `spawnpoint/release-pipeline.tfstate`. The GitHub identity independently uses
`infra/terraform-github` and state key `spawnpoint/github-oidc.tfstate`. Deleting or replacing the host can no longer
include either slice.

Local verification used the pinned Terraform 1.15.8 image and no AWS apply:

```bash
terraform -chdir=infra/terraform-releases fmt -check -diff
terraform -chdir=infra/terraform-releases init -backend=false
terraform -chdir=infra/terraform-releases validate
terraform -chdir=infra/terraform-releases test

terraform -chdir=infra/terraform-github fmt -check -diff
terraform -chdir=infra/terraform-github init -backend=false
terraform -chdir=infra/terraform-github validate
terraform -chdir=infra/terraform-github test
```

Results: release pipeline **2 passed / 0 failed**; GitHub identity **2 passed / 0 failed**. The host root remained valid
with **12 passed / 0 failed**, and bootstrap with **1 passed / 0 failed** after adding both native-lock cleanup keys.

Real remote-state plans were then reviewed:

```bash
terraform -chdir=infra/terraform-releases init -reconfigure -backend-config=backend.hcl
terraform -chdir=infra/terraform-releases plan -lock-timeout=30s -no-color

terraform -chdir=infra/terraform-github init -reconfigure -backend-config=backend.hcl
terraform -chdir=infra/terraform-github plan -lock-timeout=30s -no-color
```

Results:

- releases: **8 add / 0 change / 0 destroy** — source object, log group, CodeBuild project, two roles, two inline
  policies and one Standard Workflow;
- GitHub: **3 add / 0 change / 0 destroy** — GitHub OIDC provider, one exact-subject role and its inline policy.

The GitHub trust subject is exactly
`repo:DrArzter/my-docker-minecraft-server-config:ref:refs/heads/main`, with audience `sts.amazonaws.com`. The role can
only `states:StartExecution` on `spawnpoint-build-release` and `states:DescribeExecution` for that machine's own
executions. It has no direct CodeBuild, S3, SSM, EC2 or Parameter Store access.

The workflow itself was checked with:

```bash
docker run --rm \
  -v "$HOME/Programming/my-docker-minecraft-server-config:/repo:ro" \
  -w /repo rhysd/actionlint:1.7.7
```

Result: no diagnostics. `actions/checkout` and `aws-actions/configure-aws-credentials` are pinned to immutable commit
SHAs rather than mutable tags.

## Apply and acceptance

Both plans were saved and applied independently on 2026-08-25:

```bash
terraform -chdir=infra/terraform-releases plan \
  -lock-timeout=30s -out=/tmp/spawnpoint-releases-20260825.tfplan
terraform -chdir=infra/terraform-releases apply \
  /tmp/spawnpoint-releases-20260825.tfplan

terraform -chdir=infra/terraform-github plan \
  -lock-timeout=30s -out=/tmp/spawnpoint-github-20260825.tfplan
terraform -chdir=infra/terraform-github apply \
  /tmp/spawnpoint-github-20260825.tfplan
```

Apply results: releases **8 added / 0 changed / 0 destroyed**; GitHub **3 added / 0 changed / 0 destroyed**. Both
post-apply plans reported `No changes`. The AWS API independently reported CodeBuild
`spawnpoint-release-builder` as `BUILD_GENERAL1_SMALL`, concurrency `1`, S3 source; Step Function
`spawnpoint-build-release` as `ACTIVE / STANDARD`. IAM returned the exact subject and audience above and only the two
documented Step Functions permissions. No build was started, EC2 remained outside both states, and no world pointer was
changed.

The Action was pushed to configuration commit `fe3cd7f`, and GitHub reported the workflow from `main`. Its two
non-secret repository variables were set and read back:

```bash
gh variable set AWS_RELEASE_ROLE_ARN \
  --repo DrArzter/my-docker-minecraft-server-config \
  --body arn:aws:iam::${ACCOUNT_ID}:role/spawnpoint-github-release

gh variable set AWS_BUILD_RELEASE_STATE_MACHINE_ARN \
  --repo DrArzter/my-docker-minecraft-server-config \
  --body arn:aws:states:eu-central-1:${ACCOUNT_ID}:stateMachine:spawnpoint-build-release

gh workflow view build-release.yml \
  --repo DrArzter/my-docker-minecraft-server-config --yaml
```

These values are resource identifiers, not credentials. The Action gets temporary credentials only after AWS verifies
its signed OIDC token.

Before the first modded build:

Completed on 2026-08-25. `CF_API_KEY` was parsed from the owner's existing private dotenv file and piped directly to
`aws ssm put-parameter`; the value was never printed. Parameter `/spawnpoint/releases/curseforge-api-key` is a Standard
`SecureString`, version 1. A comparison after decryption confirmed that AWS stored the exact dotenv value, and a direct
CurseForge request returned HTTP 200.

The first dispatch, GitHub run `32899722049`, proved checkout, profile validation, OIDC, STS, Step Functions, Parameter
Store injection, the pinned resolver image, and resolution of **111 JARs / 623,584,605 bytes**. It then failed safely
before the manifest commit marker. The cause was real input the tests had missed:
`dungeons-and-taverns-3.0.3.f[Forge].jar`. `upload-release.sh` supplied S3 metadata using AWS CLI shorthand, where `]`
is syntax rather than an opaque filename character. Some payload objects had already uploaded, but without
`releases/1.1/manifest.json` the candidate was correctly invisible as a complete release.

Commit `62d993c` serialises S3 metadata as JSON and adds a regression using that exact filename shape. The release,
builder and backup S3 tests passed. Terraform then applied only the content-addressed builder update: **1 added / 2
changed / 1 destroyed**; the destroyed object was the old builder ZIP in the versioned bucket. No host or world
resource was in the plan.

The retry, GitHub run `32900764882`, completed successfully in **4m26s**. Acceptance evidence:

- manifest release `1.1`, Minecraft `1.20.1`, Forge `47.4.10`;
- source profile `main` at exact config commit `fe3cd7f06a89f65454dbf8878d7e3c14f61db100`;
- **111 JARs / 623,584,605 bytes** in the manifest;
- **112 S3 objects / 623,605,181 bytes** under `releases/1.1/`: payload plus manifest;
- manifest SHA-256 `9564b5bb4eeca49ef3b37d5f5105e7065c5c6be8f3f80963968208a0db96e7ce`, equal locally,
  in object metadata and in the S3 checksum;
- EC2 remained `stopped`, no `worlds/` pointer was created, and the post-fix Terraform plan reported `No changes`.

Release construction is now acceptance-tested. Promotion deliberately remains a separate operation: building a
candidate cannot change `desired_release`, `active_release`, start EC2 or touch a world.

## Deployment operations root

On 2026-08-26 the idle watchdog and release promotion were removed from the unapplied portion of the disposable host
root and placed in `infra/terraform-operations`, using the independent state key
`spawnpoint/operations.tfstate`. This avoids accepting the host root's unrelated EC2/EBS replacement proposal merely
to deploy orchestration. The existing start and stop machines are consumed by stable ARN; the current host is read only
to scope the watchdog's SSM permission to `i-09c9b5069308ac372`.

Local checks, which use mock AWS data and create nothing:

```bash
terraform -chdir=infra/terraform-operations fmt -check -diff
terraform -chdir=infra/terraform-operations init -backend=false
terraform -chdir=infra/terraform-operations validate
terraform -chdir=infra/terraform-operations test

terraform -chdir=infra/terraform validate
terraform -chdir=infra/terraform test
terraform -chdir=infra/terraform-bootstrap validate
terraform -chdir=infra/terraform-bootstrap test
```

Results: operations **2 passed / 0 failed**, host **10 passed / 0 failed**, bootstrap **1 passed / 0 failed**. Both ASL
documents independently returned `result=OK` and no diagnostics from
`aws stepfunctions validate-state-machine-definition`.

The production deployment used a saved plan:

```bash
terraform -chdir=infra/terraform-operations init \
  -reconfigure -backend-config=backend.hcl
terraform -chdir=infra/terraform-operations plan \
  -lock-timeout=30s -out=/tmp/spawnpoint-operations-20260826.tfplan
terraform -chdir=infra/terraform-operations show \
  /tmp/spawnpoint-operations-20260826.tfplan
sha256sum /tmp/spawnpoint-operations-20260826.tfplan
terraform -chdir=infra/terraform-operations apply \
  /tmp/spawnpoint-operations-20260826.tfplan
```

The reviewed plan digest was
`cae300db2650b0c123f5be5d3c3da857b8b460dd3dcd68d0aa055a68a7fcf6d4`. Plan and apply were exactly **6 added / 0
changed / 0 destroyed**: two narrowly trusted IAM roles, two inline policies and the two Standard Workflows
`spawnpoint-idle-watchdog` and `spawnpoint-promote-release`. A post-apply production plan reported `No changes`.

The AWS API then showed both machines, no executions for either machine, EC2 still `stopped`, and
`worlds/world/release.json` still absent (HTTP 404). Deployment therefore installed inert orchestration only; it did
not start a session, promote a release or mutate world state. The existing world must be explicitly adopted at its
verified release `1.0` before the first promotion to `1.1`.

The bootstrap root was planned separately after adding cleanup for the new native lock key. Its single in-place S3
lifecycle update would also activate three previously coded but unapplied cleanup rules (`guardrails`, `github-oidc`
and `release-pipeline`). That combined housekeeping plan was deliberately **not applied** and `-target` was not used;
state locking already works and promotion does not depend on expiring old lock-object versions.

## Host pointer read boundary

Boot-time reconciliation needs to read `worlds/<world>/release.json`, but the live game-host role initially had access
only to `releases/*`. Applying the whole host root for that one permission remained unsafe because its unrelated drift
still includes compute. Ownership of this additive boundary therefore moved to the operations root; the original host
storage policy continues to own release and backup access.

After operations **3 passed / 0 failed** and host **10 passed / 0 failed**, a saved production plan contained exactly:

```text
Plan: 1 to add, 0 to change, 0 to destroy.
aws_iam_role_policy.game_host_world_pointers
```

The inline policy attaches to `spawnpoint-game-host`, grants only `s3:GetObject`, and scopes it only to
`arn:aws:s3:::spawnpoint-releases-${ACCOUNT_ID}/worlds/*`. Apply completed **1 added / 0 changed / 0 destroyed**; a
post-apply plan reported `No changes`, the AWS IAM API returned that exact single statement, and EC2 remained
`stopped`. The host can now observe desired/active state but still cannot create, change or delete a pointer.

## Adoption preflight on the game host

Commit `a3932ee` was archived as an immutable server-only maintenance bundle before the first pointer was written:

```text
S3 key: releases/1.0/server/spawnpoint-server-a3932ee.tar.zst
SHA-256: f8ec9167e5e13964821ee1755f6bce6a7b41a89780b0ddd9db0a8eac922339c2
Bytes: 45,243
S3 VersionId: Mx.DbgKF_OOAZuKnxs5ijBxhKelwBsz5
```

The key returned 404 before upload. Its archive paths were checked before publication; it contains neither `.env` nor
`server/data`. EC2 was then started directly for maintenance, without invoking the session workflow, watchdog or
Minecraft. Read-only SSM inspection proved that no container was running, the data EBS was mounted, the installed
marker named release `1.0`, and the live mod directory held 111 JARs.

SSM command `11dbff2f-914f-415b-8c60-80e9665d63bf` downloaded that exact bundle with the instance role, verified its
SHA-256 and archive paths, installed the server scripts, added only the non-secret `RELEASE_BUCKET` and `WORLD_NAME`
keys to the existing mode-0600 runtime environment, and downloaded the immutable `1.0` manifest. The new read-only
verifier returned:

```text
result=verified
release=1.0
mods=111
bytes=623534143
```

This is adoption evidence: the already-running lineage is exactly immutable release `1.0`; no JAR was copied or
changed during verification. The maintenance host was stopped directly because the game containers had never run.
Afterwards EC2 reported `stopped`, promotion still had no executions, and `worlds/world/release.json` still returned
404. Creating the pointer remains the next explicit state mutation.

## Existing-world adoption

The existing world was adopted on 2026-08-26 only after all preconditions independently held: EC2 was `stopped`,
immutable release `1.0` had a published manifest, `worlds/world/release.json` returned 404, and SSM command
`11dbff2f-914f-415b-8c60-80e9665d63bf` remained `Success` with the exact installed-payload proof above.

The first pointer was reviewed locally, then created with S3 `PutObject --if-none-match '*'`; a concurrent or repeated
adoption would receive HTTP 412 rather than overwrite state. Its complete domain value is:

```json
{
  "schema_version": 1,
  "world": "world",
  "desired_release": "1.0",
  "active_release": "1.0",
  "updated_at": "2026-08-26T16:14:03Z",
  "updated_by": "adopt-ssm-11dbff2f",
  "source": "adopt-existing"
}
```

Pointer SHA-256 is `74efd1adadbe1bbc6380b17ee443071de0acf492172123aaf2298a0cd1afcfb2`; S3 VersionId is
`RpMjFUVuZmDvOqqwGimljoh6YQB0SbPv`. A checksum-enabled download was byte-identical to the reviewed file and returned
the same full-object checksum. EC2 remained stopped and no promotion execution existed afterwards. Adoption is a
one-time migration of an already proven lineage; every subsequent pointer change must use promotion.

## First promotion attempt: safe serialization failure

The first `1.0` → `1.1` execution, `promote-20260826T161802Z`, failed before Minecraft started. The workflow correctly
attempted rollback, but both target and rollback starts rejected the pointer. Exact SSM stderr was:

```text
jq: error: Cannot index string with string "schema_version"
error: invalid release pointer: s3://spawnpoint-releases-${ACCOUNT_ID}/worlds/world/release.json
```

The S3 SDK integration had received `States.JsonToString($.document)`. Because it serialises a JSON object into its
blob itself, this produced a quoted JSON string rather than a JSON object. The failure was fail-closed: no container
started and live mods remained all **111 JARs / 623,534,143 bytes** of release `1.0`. However EC2 remained running
after the failed start/rollback, as the execution's `RollbackFailed` contract warned.

Recovery wrote the byte-identical accepted adoption pointer as a new S3 version; broken versions were retained for
forensics. A checksum-enabled round trip restored SHA-256
`74efd1adadbe1bbc6380b17ee443071de0acf492172123aaf2298a0cd1afcfb2`. SSM command
`e7e84602-1ed4-48d2-80a9-db30630cbdea` independently re-downloaded the `1.0` manifest and reverified the live payload,
then EC2 was stopped.

The regression now asserts all four pointer writes pass `$.document` directly; only nested Step Functions inputs keep
`States.JsonToString`. Operations tests passed **3 / 0** and the AWS ASL validator returned `OK`. The saved correction
plan was exactly **0 add / 1 in-place change / 0 destroy**, updating only the definition of
`spawnpoint-promote-release`; apply completed with that exact result.

## Second attempt: container filesystem mode

The corrected workflow wrote a real JSON object and the host successfully downloaded and reconciled all 111 files of
release `1.1`. Minecraft then failed before opening the world with `AccessDeniedException: /data/mods`; rollback
reconciled `1.0` but failed for the same reason. The atomic staging directory came from `mktemp -d` as mode `0700` and
was renamed directly to the container bind-mount path. Payload hashes were correct, but the non-root Minecraft user
could not traverse the directory.

The pointer rollback itself was correct (`desired_release=active_release=1.0`). SSM command
`f5f86a7f-6161-4364-9acc-7e4868fb8728` stopped all remaining observability containers, changed only the release
directory/file modes to `0755`/`0644`, and reverified all **111 JARs / 623,534,143 bytes** against immutable `1.0`.
EC2 was then stopped.

Commit `809ea09` makes directory and file modes part of reconciliation's contract and adds regression assertions. The
installed immutable maintenance bundle was:

```text
S3 key: releases/1.0/server/spawnpoint-server-809ea09.tar.zst
SHA-256: 5fa6446786443439d3a886b58b26c4de31a8d3db0d96eed71cba98bbbfa20642
Bytes: 45,365
S3 VersionId: ohop0Um.PxMwahz3bttJhzku3v3CF7gX
SSM command: 98facea8-a1d6-45d1-9ff1-75f3fcc53194
```

`installed-release-test`, `release-reconcile-test` and the full `boot-reconcile-test` passed before deployment.

## First accepted promotion

Execution `promote-20260826T163721Z` then completed `SUCCEEDED` in about **3m14s** from a stopped origin:

1. read active `1.0` and wrote desired `1.1`;
2. downloaded and atomically reconciled release `1.1`;
3. started Minecraft and passed the existing health gate;
4. committed `desired_release=active_release=1.1`;
5. ran the verified stop synchronously, archived the world, uploaded and verified the backup, and stopped EC2.

The accepted pointer is S3 VersionId `N4TTHnekWWVkgerKdX0BirtzYQED1gUk`, SHA-256
`efd5b0cb57057163faa235095a545c0245734767ec7747efb9368f30a785b5af`. The new backup is
`worlds/world/archives/world-20260826T163955Z-27ca02863028dc6983f2e4a326e4b59ae3f949779edd2f9553b16e4abe1cc6bf.tar.zst`,
**419,511,533 bytes**, with matching SHA metadata, S3 full-object checksum and VersionId
`Erd_F2zagoIl3Lhm.pHuYVeSA2c4unaJ`.

Independent acceptance found EC2 `stopped`, no running start/stop/watchdog/promotion executions, and an operations
Terraform plan with `No changes`. Release `1.1` is therefore active because it passed health, not merely because it was
requested.

## Idle-watchdog acceptance

The first production-timing watchdog drill started from clean state: active release `1.1`, EC2 stopped and no running
start, stop, watchdog or promotion executions. `scripts/start-server.sh` created start and watchdog executions with the
shared operation ID `manual-20260826T164926Z`. Start completed healthy in **96 seconds** and explicitly reported
`reconcile=applied`, `desired_release=1.1`.

An independent player query returned 0/20. The watchdog then recorded successful `Count Empty Check` states at
16:54:39, 16:59:49 and 17:05:00 UTC. Only those successful observations advanced the counter; it did not infer
idleness from elapsed time. At `3/3` it synchronously started verified-stop execution
`b7bb44c2-f348-49fa-ada0-0910355b77ed`.

The nested stop completed in about **62 seconds**: it rechecked players, ran `save-all flush`, stopped all session
containers, archived and uploaded the world, verified the object, then stopped EC2. The watchdog completed
`SUCCEEDED` with `status=stopped_idle` and `checksTotal=3` after **16m36s** total.

Acceptance backup:

```text
S3 key: worlds/world/archives/world-20260826T170524Z-7346253eec7e2de6a4d3087cfdda13d6c24c64ef5c7ad1760b77411fbf92d22c.tar.zst
SHA-256: 7346253eec7e2de6a4d3087cfdda13d6c24c64ef5c7ad1760b77411fbf92d22c
Bytes: 419,471,806
S3 VersionId: 87E7fWjXsOwBRsAAy1eMVVkNEzMUCMuV
```

S3 returned matching SHA metadata and full-object checksum. Final independent checks found EC2 `stopped`, pointer
still `desired_release=active_release=1.1`, zero running lifecycle executions and `No changes` in the operations
Terraform root. The production start → observe → verified backup → automatic stop path is now acceptance-tested.
