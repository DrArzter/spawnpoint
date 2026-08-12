# ADR-0030 — Separate the desired release from the active release

- Status: Accepted
- Date: 2026-08-11
- Milestone: M3
- Supersedes: the deployment-trigger semantics in [ADR-0009](0009-s3-as-mod-source-of-truth.md). Its S3 layout,
  immutable-release rule and explicit promotion decision still stand
- Complements: [ADR-0025](0025-step-functions-for-long-operations.md), which owns the execution model

## Context

[ADR-0009](0009-s3-as-mod-source-of-truth.md) gives `channels/live.json` two incompatible jobs: writing it is the
deployment trigger, but the release is also described as live only after the server passes its health check. During
that interval one value cannot truthfully mean both "what should be installed" and "what was proved to work".

The ambiguity matters on failure. If the instance restarts after the files have been reconciled but before the
pointer is committed, boot-time reconciliation may restore the previous version. If the pointer is committed first,
a failed deployment makes the broken version look live. A deployment operation also needs its own durable record;
S3 object history alone cannot express validation, health checks, rollback progress or the reason for failure.

This is the same distinction made by declarative infrastructure tools: desired state is the target, an apply tries
to reach it, and observed state is updated only after the result has been checked.

## Decision

Each world has two release pointers:

| Pointer | Meaning |
| --- | --- |
| `desired_release` | The release the control plane is currently trying to make true |
| `active_release` | The last release that started successfully and passed the full health check |

A promotion starts a Step Functions execution whose input and history contain at least:

- operation ID and world ID;
- requested release and previous active release;
- requester and timestamps;
- current state and workflow execution ARN;
- terminal result and a bounded diagnostic summary.

The normal transition is:

```text
requested
    -> validating
    -> desired_written
    -> saving
    -> reconciling
    -> starting
    -> health_checking
    -> active_committed
```

If the world is stopped, promotion ends in `pending_start`: `desired_release` changes and `active_release` does not.
The next start reconciles to the desired release, runs the same health check, and commits it as active.

On a failed deployment:

1. the operation records the failed requested release and reason;
2. the runtime is reconciled back to the previous active release;
3. the previous release is started and checked;
4. `desired_release` is reset to that previous active release, so a later boot does not retry a known-bad release;
5. the operation ends as `rolled_back`, or `rollback_failed` if recovery also fails.

`active_release` is never moved merely because files were copied or a container process exists. It changes only
after the game answers a server-list ping, the control path completes an RCON check, and the active connectivity
mode is reachable.

Only one mutating operation may run for a world. A promotion, start, restore or world switch that conflicts with it
joins the existing compatible execution or fails visibly; it never races it. The exact single-flight mechanism is
owned by ADR-0025 and remains an implementation question; this ADR does not add an operation-state table.

## Consequences

**Good**

- The UI can distinguish "1.4 requested" from "1.3 is still the last known-good version".
- A restart in the middle of deployment has an unambiguous recovery target.
- Rollback is an explicit state transition rather than an S3 pointer trick.
- The deployment record can explain a failure after the workflow execution history has expired.
- The model extends naturally to several worlds because each world owns its own pointers and lease.

**Bad, or risky**

- Two pointers and an operation record must be updated consistently.
- `desired != active` is a legitimate state while stopped or deploying, so every surface has to display it honestly.
- A rollback can itself fail and needs a terminal state distinct from an ordinary deployment failure.
- The design is more machinery than a single `live.json` object.

**Mitigations**

- Every host-side action is idempotent and receives the operation ID and exact release version.
- S3 releases remain immutable; the pointers contain identifiers, never mutable release contents.
- The workflow execution is the operation state, per ADR-0025; desired and active pointers remain durable after its
  execution history expires.

## Alternatives considered

| Option | Why not chosen |
| --- | --- |
| One `live` pointer written before deployment | Simple trigger, but a failed version appears live and boot retries it |
| One `live` pointer written after deployment | Preserves last-known-good state, but gives the in-flight target no authoritative home |
| Keep desired after automatic rollback | Declaratively pure, but every boot retries a release already known to fail. A manual retry is safer for a small game server |
| Infer state from files on EBS | Makes a disposable instance directory the source of truth and cannot explain who requested the change |

## Open questions

- Whether desired and active pointers are separate S3 objects or fields in one versioned channel document. Prefer one
  document if its update can preserve the distinction without making partial transitions ambiguous.
- Exact health thresholds. M0 must measure normal and worst observed modded-server startup time before M3 chooses
  the timeout.
- Whether a failed release is automatically quarantined from promotion until its manifest changes.
