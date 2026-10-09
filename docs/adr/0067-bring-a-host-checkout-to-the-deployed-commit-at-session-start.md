# ADR-0067 — Bring a host's checkout to the deployed commit when a session starts

- Status: Accepted
- Date: 2026-10-09
- Milestone: M6
- Relates: [ADR-0043](0043-deploy-production-from-reviewed-pull-requests.md), [ADR-0054](0054-place-a-session-on-a-host-with-room.md),
  [ADR-0063](0063-run-console-commands-through-one-ssm-document.md)

## Context

Every script a session runs comes from the host's checkout under `/srv/spawnpoint/app`. The deploy pipeline does not
reach it (ADR-0043). A launched host checks out the deployed commit once, at boot, from its `AppCommit` tag. Two kinds
of host keep older code:

- the configured host, updated only by hand;
- a warm fleet host, stopped and started again for up to fourteen days, which keeps the commit it booted with.

The console (ADR-0063), game settings and the whitelist each needed "update the configured host's checkout" in the
runbook. A host is stopped most of the time, so a deploy cannot send it a command; and while a game runs, its scripts
and Compose files must not change under it.

## Decision

**The deployed commit is a parameter.** The access API root writes `var.app_commit`, the tested commit the pipeline
deploys, to `/spawnpoint/host/app-commit`. Hosts already read `/spawnpoint/host/*`. A change under `server/` now also
applies the access API root, so the parameter moves whenever host code changes.

**A session start updates the checkout first.** Each of the start workflow's three session commands runs
`server/scripts/update-checkout.sh` before `start-session.sh`. The script reads the parameter and fetches and checks out
that commit, only when:

- no game container runs on the host (`check-host-activity.sh`);
- no tracked file has a local change;
- the value is a commit or a ref name, never something git reads as an option.

Otherwise it keeps the checkout and says why. It never fails the start: a host that cannot fetch starts on the code it
has. Its output goes to standard error, because the session summary is read from standard output.

The command line in the workflow is a fixed string, so callers of the start workflow that send no commit are unchanged.

## Consequences

- A deploy reaches every host at its next idle start. A host that runs a game keeps its code until the last session on
  it stops and a new one starts.
- The configured host needs its checkout updated by hand one last time, to receive `update-checkout.sh`. The runbook
  has the command.
- A start's command output records `result=updated`, `current` or `kept` with a reason.
- Untracked and ignored files (`server/.env`, world data, runtime state) are never touched. A hand edit to a tracked
  file blocks updates until it is removed.

## Alternatives

| Option | Why not |
| --- | --- |
| Send an update command from the deploy | The configured host is stopped most of the time, and a running game must not change under it |
| Pass the commit in the start request | Several callers start sessions without one; a missing field would fail their starts |
| Follow `main` on the host | `main` can hold a commit whose deploy failed; the host would run code production does not |
| Replace hosts instead of updating them | Right for launched hosts, which already do so; the configured host carries state that a replacement loses |
