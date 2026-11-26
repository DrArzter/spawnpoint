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

## Session volume

ADR-0102, step 2. `session_volume` is `disabled` unless the repository variable `SPAWNPOINT_SESSION_VOLUME` is
`enabled`; `session_volume_size_gib` (default 30) sizes each volume. The start and stop roles may create, attach,
detach and delete only volumes tagged `ManagedBy=spawnpoint-session-volume`, and attach or detach them only on hosts
tagged `ManagedBy=spawnpoint-fleet` (`session-volume.tf`). The host stack (`infra/terraform`) deploys first and owns the
`spawnpoint-start-session` parameter and the `spawnpoint-unmount-session-volume` document the workflows use.

The `spawnpoint-session-volume-sweeper` Lambda runs every 15 minutes, whether or not the switch is on. It deletes an
`available` session volume older than one hour whose world's record (`world#<id>`) has another or no active session.
A volume it cannot delete, one still attached four hours after its session ended, or one with no `SessionId` tag fails
the run, and the `spawnpoint-session-volume-survived` alarm reports it.

## Spot

ADR-0102, step 3. `spot` is `disabled` unless the repository variable `SPAWNPOINT_SPOT` is `enabled`, and it takes
effect only while `session_volume` is also `enabled`. When it is `enabled`, `spot.tf` creates the
`AWSServiceRoleForEC2Spot` service-linked role, which EC2 needs to launch Spot capacity and which the account does not
have yet (checked 2026-11-26). The start role keeps `ec2:CreateFleet` and gains no IAM rights. To switch Spot off again,
first let every Spot host end: AWS refuses to delete the role while an instance uses it.

Each fleet world can refuse Spot. Its **Pricing** choice in Hosting & connection (`market` on the settings API, stored as
`on_demand` on the world record) is sent with every start and promotion; `on-demand` keeps the session off Spot hosts
and launches its host On-Demand. A world with no saved choice runs on Spot where its game allows it. The panel offers the
choice only while the access API root also has `spot` and `session_volume` enabled.

### Interruption and fault test

ADR-0102, steps 5 and 7. While `spot` is `enabled`, `spot.tf` also creates the `spawnpoint-spot-interruption` Lambda,
its three EventBridge rules and the `spawnpoint-spot-interruption-failed` alarm (see `workflows/README.md`). The
repository variable `SPAWNPOINT_SPOT_FAULT_TEST` (`spot_fault_test`, default `disabled`) adds `spot-fault-test.tf`: an
FIS role and the experiment template `spawnpoint-spot-interruption`, which sends a two-minute Spot notice to one
running host tagged both `ManagedBy=spawnpoint-fleet` and `SpawnpointFaultTarget=armed`, and stops when that alarm
fires. Only `scripts/spot-fault-test.sh` arms a host.

Production values: `SPAWNPOINT_SESSION_VOLUME`, `SPAWNPOINT_SPOT` and `SPAWNPOINT_SPOT_FAULT_TEST` are `enabled` since
2026-11-26. The deploy applies only the roots that a commit changes, so a change to one of these variables takes effect
at the next commit that changes this root.

## Local verification

```bash
terraform fmt -check -diff
terraform init -backend=false
terraform validate
terraform test
```

Mock tests create no AWS resources. Deploying the definitions is inert; starting an execution is a separate, explicit operation.
