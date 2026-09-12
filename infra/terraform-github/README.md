# GitHub Actions identity

This Terraform root owns two deliberately separate workflow identities. The release role is trusted by
`DrArzter/my-docker-minecraft-server-config` on `main` and may start the fixed
`spawnpoint-build-release` Standard Workflow and inspect only that workflow's executions. It cannot invoke CodeBuild,
read the CurseForge key, write S3 objects, start EC2, send SSM commands or promote a release.

The deployment role trusts only the immutable Spawnpoint repository identity and its `production` environment.
Its inline policy enumerates the read/create/update operations used by the current Terraform resources, limits IAM
management to `spawnpoint-*` identities, and permits deletion only for Terraform state locks and obsolete static web
assets. It has no broad AWS managed policy. An explicit deny prevents the role from changing itself. Production
Terraform additionally refuses every plan containing an infrastructure delete or replacement.

This root is never auto-applied: the deployment identity cannot be allowed to edit its own trust or permissions.
It remains separate from `../terraform`, so replacing the disposable host cannot remove the account-level OIDC
provider. GitHub receives temporary STS credentials; there are no AWS access keys to store or rotate.

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

Review this root manually before every apply. Applying it does not run a build and does not create paid compute.

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

For this repository, create the `production` environment and configure the deployment role:

```bash
gh api --method PUT repos/DrArzter/spawnpoint/environments/production
gh variable set AWS_DEPLOY_ROLE_ARN \
  --repo DrArzter/spawnpoint \
  --env production \
  --body "$(terraform output -raw github_deploy_role_arn)"
```

The environment also needs `TF_VAR_ALERT_EMAIL` and `TF_VAR_BOOTSTRAP_OWNER_TELEGRAM_ID` as environment secrets
for the two Terraform roots that declare those sensitive inputs.

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
