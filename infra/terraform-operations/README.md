# Session and deployment operations

This Terraform root owns composed Standard Workflows that sit above the already deployed host workflows:

- `spawnpoint-promote-release` moves one wipe between immutable releases through Lifecycle V2 and commits
  `active_release` only after health and watchdog registration succeed;
- the `spawnpoint-*-v2` lifecycle trio coordinates fenced sessions through the established DynamoDB coordinator.
  V1 is a private host adapter used only by these V2 workflows.

It is deliberately separate from `../terraform`. Applying this root must not replace the EC2 instance, detach EBS,
or modify the primitive host workflows. It discovers the current game host only to scope the watchdog's SSM
permission; promotion invokes fixed Lifecycle V2 ARNs and never accepts workflow ARNs from its caller.

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

## Release reconciler

`spawnpoint-release-reconciler` (ADR-0080) runs weekly on Sunday at 05:00 UTC. It lists and reads the release sources, scans
`spawnpoint-release-refs` and puts metrics in `Spawnpoint/ReleaseReconciler`. Then it plans a sweep: it deletes the object of a file
that is condemned for 14 days, has no reference, and is named by no manifest of a complete run that started after the file was
condemned. It also finishes or reverts stuck `deleting` items and condemns orphan objects. It only reports missing references or
holders, extra references and counter drift.

The sweep is a dry run unless the Terraform variable `release_sweep_dry_run` is `false`. In CI it comes from the repository variable
`SPAWNPOINT_RELEASE_SWEEP_DRY_RUN`; an unset variable means `true`. A dry run writes nothing, logs one `release_sweep_action` line for each
action it would take, and puts `SweepDryRun = 1`. Read at least four weekly dry runs before you set the variable to `false`.
The Lambda treats any value other than the exact string `false` as a dry run.

The role may delete under `objects/*` (never a version) and update or put file items (`file#*`) in the table. It has no other write
or delete action. The alarm `spawnpoint-release-reconciler-sweep-failed` fires when a delete or write fails (`SweepFailed`).
For an on-demand run, invoke the Lambda by hand with `{}` or `{"mode":"report"}`; any other mode is refused. The result and one log
line per class are in `/aws/lambda/spawnpoint-release-reconciler`. The table is created in `../terraform-storage`.

## Local verification

```bash
terraform fmt -check -diff
terraform init -backend=false
terraform validate
terraform test
```

Mock tests create no AWS resources. Deploying the definitions is inert; starting an execution is a separate, explicit operation.
