# GitHub Actions identity

This Terraform root gives exactly one workflow identity to
`DrArzter/my-docker-minecraft-server-config` on `main`. The workflow may start the fixed
`spawnpoint-build-release` Standard Workflow and inspect only that workflow's executions. It cannot invoke CodeBuild,
read the CurseForge key, write S3 objects, start EC2, send SSM commands or promote a release.

It is separate from `../terraform`: replacing or destroying the disposable game host must not remove the account-level
GitHub OIDC provider. The root owns the provider, one role and one inline policy. GitHub receives temporary STS
credentials; there are no AWS access keys to store or rotate.

## Order

`bootstrap` → `guardrails` → `storage` → `releases` → **`github`**.

The role policy can be planned before the state machine exists, but applying it after the release-pipeline root makes
the first workflow run immediately useful. It has no dependency on the game-host root.

## Plan and apply

Copy `backend.hcl.example` to ignored `backend.hcl`, replace the account ID, then:

```bash
terraform init -backend-config=backend.hcl
terraform plan -out=github.tfplan
terraform show github.tfplan
terraform apply github.tfplan
```

The expected first plan is three resources: one `aws_iam_openid_connect_provider`, one `aws_iam_role`, and one
`aws_iam_role_policy`. Applying this root does not run a build and does not create paid compute.

After apply, copy the workflow outputs into GitHub repository **variables** (not secrets):

```bash
gh variable set AWS_RELEASE_ROLE_ARN \
  --repo DrArzter/my-docker-minecraft-server-config \
  --body "$(terraform output -raw github_release_role_arn)"

gh variable set AWS_BUILD_RELEASE_STATE_MACHINE_ARN \
  --repo DrArzter/my-docker-minecraft-server-config \
  --body "$(terraform output -raw build_release_state_machine_arn)"

gh variable set AWS_PRESET_CATALOG_STATE_MACHINE_ARN \
  --repo DrArzter/my-docker-minecraft-server-config \
  --body "$(terraform output -raw publish_preset_catalog_state_machine_arn)"

gh variable set AWS_RELEASE_BUCKET \
  --repo DrArzter/my-docker-minecraft-server-config \
  --body "$(terraform output -raw release_bucket_name)"
```

The workflow uploads a content-addressed snapshot of the selected Git commit to the release bucket. This lets the
same pipeline consume public or private config repositories without a long-lived GitHub credential in CodeBuild.
The CurseForge key stays in AWS Systems Manager Parameter Store. GitHub never sees it.

## Local verification

```bash
terraform fmt -check -diff
terraform init -backend=false
terraform validate
terraform test
```

The mock tests use no AWS credentials and create no resources. They pin the OIDC audience and exact repository/branch
subject, plus both Step Functions ARN scopes.
