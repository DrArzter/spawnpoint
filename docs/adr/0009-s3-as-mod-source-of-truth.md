# ADR-0009 — S3 holds releases, and promotion drives the deployment

- Status: Accepted
- Date: 2026-08-11
- Milestone: M3

## Context

[ADR-0008](0008-versioned-mod-releases.md) defines *what* a release is. This ADR covers where releases
live and what happens when one is promoted.

Two mechanisms are possible. Either any write to the mod area triggers a deployment, which is simple but
fires on half-finished uploads and on every file of a five-file change. Or uploads are inert and a separate,
explicit act promotes a release, which is one more step and considerably safer.

## Decision

An S3 bucket is the store:

```
releases/<version>/manifest.json     immutable release definition
releases/<version>/mods/...          mod binaries (or hash-addressed, see ADR-0008)
channels/live.json                   the pointer: which version is live
staging/                             uploads land here; inert
```

Uploads to `staging/` trigger nothing. Writing `channels/live.json` is the deployment trigger. Bucket
versioning is on for the whole bucket, so the pointer's own history is the deployment history.

A promotion runs this sequence as a Step Functions state machine, with Lambda for the steps that carry real logic. The
retries and the rollback branch below are declared in the state machine rather than hand-written. See
[ADR-0025](0025-step-functions-for-long-operations.md).

1. Validate the manifest: hashes present, files exist, loader and Minecraft versions consistent.
2. Announce the pending change to the chat channels, with a delay if players are online.
3. Save the world and stop the game container, if the server is running.
4. Reconcile the mod directory on the instance against the release, via SSM Run Command.
5. Start the container and wait for a healthy server.
6. On success, build the client pack and announce the new version. On failure, move the pointer back to
   the previous release, repeat steps 3–5, and announce the rollback.

If the server is not running, steps 3–6 are skipped. Boot always reconciles against the live release, so
the change lands at the next start.

## Consequences

**Good**

- A half-uploaded release cannot deploy itself, because uploads are inert.
- One trigger, one deployment, regardless of how many files changed.
- The pointer's version history in S3 *is* the deployment log: who deployed what, and when.
- Automatic rollback on a failed start, so a bad mod costs minutes rather than an evening.
- Structurally this is a deployment pipeline with a promote step. That is the transferable part.

**Bad, or risky**

- More moving parts than copying files onto the server, and every part can fail.
- Health checking "the server actually came up" is harder than it looks with a modded pack, where a slow
  start and a hung start look alike for the first few minutes.
- Players are disconnected by a deployment, with limited warning.
- Redistributing mod binaries has licence implications that vary per mod.

**Mitigations**

- Health check on the server list ping plus a successful RCON command, with a generous timeout derived
  from the measured normal start time, and an explicit "still starting" state so a slow start is not
  treated as a failure.
- Announce first, act second, with a delay when players are online, and refuse a non-urgent promotion
  during an active session unless forced.
- For the player-facing artefact, prefer a manifest of mod identifiers and versions over re-hosting
  binaries where the licence does not permit it. See [ADR-0013](0013-modpack-distribution.md).
- Every step reports to the chat channels, so a stuck pipeline is visible rather than silent. See
  [ADR-0016](0016-chat-integrations.md).

## Alternatives considered

| Option | Why not chosen |
| --- | --- |
| Any S3 write triggers the deployment | Simplest possible pipeline, and the first thing considered. Deploys partial uploads, and fires once per file. Rejected on safety |
| Debounce a quiet period after the last write | Removes the multi-file problem, but the trigger stays implicit, so there is no moment that means "I meant this" |
| GitHub Actions on a push to a manifest repository | A stronger pipeline with review and CI, and the natural next step. Rejected for now because it puts a second source of truth beside S3, and needs the CI identity decided first |
| Copy files by hand over SSM | Zero build cost, and the M0 behaviour. It is the manual process this ADR exists to remove |
| EFS shared between instances | Solves nothing here — there is one instance — and adds fixed cost |

## Open questions

- Whether a promotion is allowed while players are online, and whether a forced one is permitted.
- Whether validation is strict enough to catch a mod that is present but corrupt, beyond a hash check.
- Whether the pipeline should test a release on a throwaway instance before promoting it. Correct, and
  probably beyond the scope of a hobby budget. Revisit after M3.
