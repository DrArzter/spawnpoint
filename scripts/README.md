# scripts

Owner and deployment helpers. Interactive commands run from a laptop; the idempotent deployment helpers are shared
with GitHub Actions so production does not maintain a second implementation.

Available:

| Script | Purpose |
| --- | --- |
| `audit-aws-bootstrap.sh` | Read-only verification of browser credentials, IAM MFA and keys, budget alerts, recipients and SNS subscriptions. See [the command reference](../docs/aws-cli-checks.md) |
| `backups.sh` | List recent immutable world backups from S3 |
| `logs.sh` | Fetch a bounded Minecraft log snapshot through SSM without SSH |
| `operations.sh` | Show recent start/stop Step Functions executions |
| `players.sh` | Ask the running server for its current player list through SSM and RCON |
| `session.sh` | Command dispatcher and interactive menu for the local operator toolbox |
| `start-server.sh` | Start or join the M2 Standard Workflow and optionally follow it until Minecraft is ready |
| `status-server.sh` | Read-only EC2, workflow, storage, latest-backup and live private-endpoint status |
| `stop-server.sh` | Save, back up and stop through the M2 Standard Workflow; refuses while players are online |
| `deploy-web.sh` | Build and publish the static panel; skips upload when the built `index.html` is unchanged |
| `deploy-lambdas.sh` | Build every Lambda bundle and update only functions whose archive hash changed |
| `terraform-init-ci.sh` | Initialise one remote-state root from its committed backend key and the current AWS account |
| `terraform-apply-safe.sh` | Plan and apply one root, refusing deletes and replacements |
| `terraform-plan-safe.sh` | Plan one changed root read-only for a pull request and refuse deletes or replacements |
| `deployment_plan.py` | Convert a tested Git diff into web, Lambda and exact Terraform deploy units |

Planned:

| Script | Purpose |
| --- | --- |
| `cut-release.sh` | Build a release from a working mod set: hashes, manifest, upload. See [ADR-0008](../docs/adr/0008-versioned-mod-releases.md) |
| `promote.sh` | Request a desired release, and follow the resulting deployment operation |
| `restore-world.sh` | Restore a world archive into a new volume or path, never over the live world |
| `cost.sh` | Month-to-date cost by service, for the monthly check in the [runbook](../docs/runbook.md#monthly-cost-check) |

Rules:

- Anything that changes state goes through the control-plane API, so the rules are not duplicated here. The
  exception is genuine break-glass, which must be obvious in the script name and output.
- Print what will happen and require confirmation before anything destructive.
- Safe to run twice.

This directory is also the fallback path when the panel or the bots are unavailable. It must keep working
without them.

`start-server.sh` and `stop-server.sh` use the authenticated local AWS profile only to call the control plane. They do
not reproduce the EC2/SSM sequence: that remains in Step Functions. Use `--no-follow` to return immediately after
receiving the execution ARN; without it, the script follows the durable AWS execution until its terminal result.
Stopping asks for confirmation; automation must opt in explicitly with `--yes`.

`status-server.sh` makes no state-changing calls. When EC2 is running it also probes Minecraft and Grafana through
their private ZeroTier addresses; an unreachable probe does not change or restart anything.

`logs.sh` and `players.sh` submit bounded, read-only Run Command jobs to an already-running EC2 host. They never start
the instance. `backups.sh` and `operations.sh` read AWS APIs directly. Run `session.sh` without arguments for a menu,
or use it as a dispatcher, for example `session.sh logs --lines 200`.

**Status:** the account-bootstrap audit and minimal M2 start/stop triggers exist. `cut-release.sh` arrives in M3, the
rest as needed.
