# Session and deployment operations

This Terraform root owns composed Standard Workflows that sit above the already deployed host workflows:

- `spawnpoint-idle-watchdog` observes one running session and invokes the verified stop after sustained idleness;
- `spawnpoint-promote-release` moves a world from one immutable release to another and commits `active_release` only after the existing start workflow passes its health check.
- the additive `spawnpoint-*-v2` lifecycle trio coordinates fenced sessions through the established DynamoDB
  coordinator while V1 remains the production default.

It is deliberately separate from `../terraform`. Applying this root must not replace the EC2 instance, detach EBS, or modify the start and stop machines. It discovers the current game host only to scope the watchdog's SSM permission and refers to the existing child workflows by their stable names.

The root also owns one additive policy on the established game-host role: read-only `GetObject` access to
`worlds/*`. The host needs it to observe desired/active state during boot, but cannot write a pointer. Keeping this
permission here avoids applying unrelated disposable-host drift merely to activate deployment reconciliation.

## Order

`bootstrap` → `guardrails` → `storage` → `host` → `releases` → **`operations`** → `github`.

The host and immutable release candidate must exist before promotion is useful. Creating these workflows does not start EC2 or execute a promotion.

## Plan and apply

Copy `backend.hcl.example` to ignored `backend.hcl`, replace the account ID, then review a saved plan before applying it:

```bash
terraform init -backend-config=backend.hcl
terraform plan -out=operations.tfplan
terraform show operations.tfplan
terraform apply operations.tfplan
```

The first deployment contained six additions: two IAM roles, two inline policies and two Step Functions state
machines. Lifecycle V2 Phase 5 is a later additive plan containing exactly nine more: three roles, three inline
policies and three state machines.

## Local verification

```bash
terraform fmt -check -diff
terraform init -backend=false
terraform validate
terraform test
```

Mock tests create no AWS resources. Deploying the definitions is inert; starting an execution is a separate, explicit operation.
