# scripts

Local helpers for the owner, run from a laptop with AWS credentials. Deliberately separate from
[`lambdas/`](../lambdas/README.md): these are for the person who maintains the system, not for the automation.

Planned:

| Script | Purpose |
| --- | --- |
| `cut-release.sh` | Build a release from a working mod set: hashes, manifest, upload. See [ADR-0008](../docs/adr/0008-versioned-mod-releases.md) |
| `promote.sh` | Request a desired release, and follow the resulting deployment operation |
| `restore-world.sh` | Restore a world archive into a new volume or path, never over the live world |
| `cost.sh` | Month-to-date cost by service, for the monthly check in the [runbook](../docs/runbook.md#monthly-cost-check) |
| `logs.sh` | Tail the game server log through SSM |

Rules:

- Anything that changes state goes through the control-plane API, so the rules are not duplicated here. The
  exception is genuine break-glass, which must be obvious in the script name and output.
- Print what will happen and require confirmation before anything destructive.
- Safe to run twice.

This directory is also the fallback path when the panel or the bots are unavailable. It must keep working
without them.

**Status:** empty. `cut-release.sh` arrives in M3, the rest as needed.
