# ADR-0082 — The V1 machines are the V2 host step, and host input goes through SSM documents

- Status: Accepted
- Date: 2026-11-23
- Milestone: M6
- Amends: [ADR-0063](0063-run-console-commands-through-one-ssm-document.md) (its pattern now covers the
  session host steps too)

## Context

Lifecycle V2 starts and stops a session through the V1 machines: `spawnpoint-start-server` and
`spawnpoint-stop-server` are the host step under the V2 machines, not a second generation of the lifecycle. The host
step sent `AWS-RunShellScript` with a shell line that `States.Format` built from the request, for example
`WORLD_ID={} SPAWNPOINT_SLOT={} … start-session.sh`. The idle watchdog's activity probe did the same.

Today every caller checks the world id first, so no exploit path is known. But nothing between the request and the
host's shell checked the values: the host's own check (`load_world`) ran only after the shell had read the line. One
caller that forgot to check would put its input into a root shell on the host.

## Decision

- Three Terraform-owned SSM documents are the host steps:
  - `spawnpoint-start-session` (core root): `worldId`, `slot`, `waitForFleet`;
  - `spawnpoint-stop-session` (core root): `worldId`, `slot`, `players`;
  - `spawnpoint-session-activity` (operations root): `worldId`, `slot`.
- Each document runs one fixed script. SSM checks every parameter before any shell reads it:
  - `worldId` against `^[a-z0-9][a-z0-9-]{0,31}$`;
  - `slot` against `^([0-9]{1,3})?$` (empty for a session that was not placed);
  - `waitForFleet` and `players` against a fixed list of values.
- The state machines pass named parameters, never a shell line. Their IAM roles may send only their own document.
  `AWS-RunShellScript` is no longer allowed for a start, a stop or a probe.
- The V1 machines keep their names. A rename would replace them, and the V2 machines in another Terraform root find
  them by name, so one deploy would leave V2 pointing at a deleted machine for a while. `workflows/README.md` records
  that they are the host step.
- Each document has one step. Its step name is also its CloudWatch stream name (`<command>/<instance>/<step>/stdout`),
  which the operation log reader opens. A test pins the step names.

## Consequences

- A value that could carry shell syntax is refused by SSM, before the host. This holds even if a caller does not check.
- A session started before this change used `AWS-RunShellScript`. The log reader still reads that stream name for
  such a session.
- Operator scripts (`scripts/logs.sh`, `scripts/players.sh`) still send `AWS-RunShellScript`. They run with the
  operator's own credentials and take no input from the panel.
- The V1 idle watchdog has no caller. It is removed in its own change.
