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
| `start-server.sh` | Start or join the Lifecycle V2 start for a named world, and optionally follow it until the game is ready |
| `status-server.sh` | Read-only EC2, workflow, storage, latest-backup and live private-endpoint status |
| `stop-server.sh` | Save, back up and stop the exact active session through Lifecycle V2; refuses while players are online |
| `deploy-web.sh` | Build and publish the static panel; skips upload when the built `index.html` is unchanged |
| `deploy-lambdas.sh` | Build every Lambda bundle and update only functions whose archive hash changed |
| `terraform-init-ci.sh` | Initialise one remote-state root from its committed backend key and the current AWS account |
| `terraform-apply-safe.sh` | Plan and apply one root; a delete or replacement runs only if the root's `destroy-allowed.txt` names its exact address |
| `terraform-plan-safe.sh` | Plan one changed root read-only for a pull request; a delete or replacement fails the check unless allow-listed the same way |
| `_terraform-destroy-allow.sh` | The judgement both safe scripts share: which destroys a root's `destroy-allowed.txt` permits, and which types may be listed at all |
| `deployment_plan.py` | Convert a tested Git diff into web, Lambda and exact Terraform deploy units |
| `upsert-pr-comment.sh` | Create or update one marker-owned GitHub Actions summary comment on a pull request |
| `terraform-verify-applied.sh` | Prove a manually applied root has a zero-change read-only plan, for the production workflow |
| `promote-release.sh` | Promote one world's current wipe to a published release through Lifecycle V2, and follow the operation |
| `cut-release.sh` | Manual bootstrap and diagnostic release cut from a working mod set; the supported path is the AWS builder |
| `import-world.sh` | Bring an existing world and its exact mods in: manifest → release → archive → upload → pointer |
| `publish-pack.sh` | Backfill the client pack for a release published before packs rode with publication |
| `migrate-world-state.sh` | Adopt a legacy world-scoped release pointer into the world and wipe model; dry-run by default |
| `migrate-preset-catalog.sh`, `migrate-release-layout.sh` | One-time migrations to the preset-scoped catalog and release layout of [ADR-0042](../docs/adr/0042-preset-scoped-release-identity.md) |
| `aws-release-builder.sh`, `aws-preset-catalog-builder.sh`, `_config-source.sh` | What CodeBuild runs: stage the exact Git snapshot, resolve, hash, publish |
| `check.sh`, `check-links.py`, `check-workflows.py` | The local evidence ladder and its hygiene checks; CI runs its named shards in parallel and keeps one aggregate gate |

Planned:

| Script | Purpose |
| --- | --- |
| `cost.sh` | Month-to-date cost by service, for the monthly check in the [runbook](../docs/runbook.md#monthly-cost-check) |

## Allowing a destroy

The production pipeline refuses every Terraform delete and replacement. Its one opening is a file in the root,
`infra/<root>/destroy-allowed.txt`, naming the exact resource address to destroy — one per line, `#` comments allowed:

```text
# the alias of the wipe route, ADR-0040
aws_apigatewayv2_route.access["POST /games/{gameId}/worlds/{worldId}/regenerate"]
```

The line travels in the same pull request as the removal, so the destroy is something a reviewer reads in the diff.
The plan check reports it as `allowed`; the apply after merge makes the same judgement against the live state. An
entry the plan no longer destroys is reported as `stale` and should be removed in the next change to that root.

Only control-plane wiring may be listed — API routes and integrations, Lambda permissions, `spawnpoint-*` roles and
policies, log groups, alarms, event rules and targets, state machines, the CodeBuild project, SNS subscriptions. The
list lives in `_terraform-destroy-allow.sh`, and the deploy identity in `infra/terraform-github` holds exactly those
delete actions. The host, its volume, the buckets, the tables, the OIDC trust, the CloudFront distribution, the bot's
Function URL and the guardrails can be listed by nobody and deleted by no pipeline run; destroying one of those is an
owner apply from a workstation, recorded in a command log.

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

**Status:** owner start, stop, status and promotion, world import and the migration tools, the builders CodeBuild
runs, and the deployment helpers GitHub Actions shares all exist. Restoring a world is `server/scripts/restore-world.sh`
from an owner workstation ([runbook](../docs/runbook.md#restore-the-world)); `cost.sh` is the one planned script left.
