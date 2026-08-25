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

Not run yet. Before the first modded build:

1. create SecureString `/spawnpoint/releases/curseforge-api-key` without printing its value;
2. apply the saved, re-reviewed release plan;
3. apply the saved, re-reviewed GitHub identity plan;
4. configure the two non-secret GitHub repository variables from Terraform outputs;
5. dispatch one new release and verify the manifest, hashes and execution result;
6. leave promotion separate — a successful build must not alter a world pointer or start EC2.
