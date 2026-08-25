# Immutable release pipeline

This Terraform root owns the inert AWS builder for immutable mod releases: a content-addressed S3 source bundle, one
small on-demand CodeBuild project, its bounded log group and roles, and the `spawnpoint-build-release` Standard
Workflow. A build publishes a candidate but never changes `desired_release`, starts EC2 or touches a world.

It deliberately does not live in `../terraform`. Release construction has no dependency on the disposable game host,
and applying this root must not replace EC2, detach EBS, deploy the bot or change session workflows. Its only external
dependencies are the persistent release bucket from `../terraform-storage` and the CurseForge SecureString parameter.

## Order

`bootstrap` → `guardrails` → `storage` → **`releases`** → `github`.

The host can be managed independently. Promotion consumes candidates later, but construction does not depend on it.

## Secret prerequisite

Create the SecureString once without putting its value in shell history:

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

CodeBuild receives the value directly from Parameter Store. GitHub and Terraform never receive it.

## Plan and apply

Copy `backend.hcl.example` to ignored `backend.hcl`, replace the account ID, then:

```bash
terraform init -backend-config=backend.hcl
terraform plan -out=releases.tfplan
terraform show releases.tfplan
terraform apply releases.tfplan
```

An apply creates only control-plane resources. CodeBuild charges only while a build actually runs; creating the project
does not start it.

## Local verification

```bash
terraform fmt -check -diff
terraform init -backend=false
terraform validate
terraform test
```

Mock tests create no AWS resources. They assert the fixed CodeBuild project, Parameter Store injection,
content-addressed source, single-flight small compute, and the Standard Workflow's caller-controlled field boundary.
