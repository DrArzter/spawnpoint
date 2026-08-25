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
  --body arn:aws:iam::614934752397:role/spawnpoint-github-release

gh variable set AWS_BUILD_RELEASE_STATE_MACHINE_ARN \
  --repo DrArzter/my-docker-minecraft-server-config \
  --body arn:aws:states:eu-central-1:614934752397:stateMachine:spawnpoint-build-release

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
