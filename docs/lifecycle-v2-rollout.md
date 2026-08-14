# Lifecycle V2 rollout

Lifecycle V2 is built beside the working M2 start/stop workflows. Until the explicit cutover, production owner
commands continue to resolve `spawnpoint-start-server` and `spawnpoint-stop-server`; incomplete V2 resources receive no
traffic. Every phase below is independently committable and leaves the existing server startable.

## State ownership

Step Functions execution history remains the operation record, per ADR-0025. DynamoDB will not copy every workflow
state. Its single lifecycle item contains only coordination facts that must outlive or be shared across executions:

- desired server state: `running` or `stopped`;
- observed server state: `stopped`, `starting`, `ready`, `stopping` or `unknown`;
- current `activeSessionId`, if any;
- current lease owner, expiry and monotonically increasing fencing token;
- the one watchdog registered for the active session and its consecutive empty-reading count.

`sessionId` prevents yesterday's watchdog from stopping today's server. The fencing token prevents a workflow whose
lease expired from resuming later and writing over its replacement. TTL cleanup alone is not a lock: DynamoDB expiry
is asynchronous, so acquisition must use a conditional write against the recorded expiry and fencing token.

## Required invariants

1. At most one unexpired mutating lease exists for a server.
2. Repeating an acquisition by the same operation is idempotent; takeover after expiry gets a strictly larger fencing
   token.
3. Every lifecycle mutation checks both lease owner and fencing token. An expired owner cannot renew itself back into
   authority.
4. A new session starts only from fully stopped state and receives a new, non-empty `sessionId`.
5. Exactly one watchdog is registered for that session. Observations from another watchdog or session are rejected.
6. Only successful zero-player reads increment the idle count. A player or failed read resets it to zero.
7. A duplicated observation ID is idempotent and cannot advance the threshold twice.
8. Stop holds its lease across player recheck, save, archive verification and EC2 stop. Start cannot cross that gap.
9. Unknown or failed observations never count as evidence that the server is empty.

The dependency-free implementation and executable examples live in
[`lambdas/src/domain/lifecycle.ts`](../lambdas/src/domain/lifecycle.ts) and
[`lambdas/test/lifecycle.test.ts`](../lambdas/test/lifecycle.test.ts). They contain no AWS SDK imports and make no AWS
calls.

## Atomic rollout phases

| Phase | Change | Production behaviour if work stops there |
| --- | --- | --- |
| 1 — domain model | Pure TypeScript state transitions and invariant tests | V1 remains unchanged and operational |
| 2 — state store | Add an empty DynamoDB table in a saved add-only Terraform plan | V1 ignores the table |
| 3 — coordinator | Deploy a short synchronous TypeScript Lambda implementing conditional DynamoDB transitions | Function is inert; no caller references it |
| 4 — host probe | Add and deploy a read-only structured player-count contract | Existing host lifecycle does not call it |
| 5 — V2 workflows | Create `*-v2` start, stop and watchdog state machines with separate IAM | V1 names remain the owner-script defaults |
| 6 — acceptance | Invoke V2 explicitly with short timings; exercise conflicts, stale sessions and backup ordering | Failures do not redirect V1 traffic |
| 7 — cutover | Change the owner/API resolver default from V1 to V2, retaining an explicit V1 override | One small revert or environment override restores V1 |
| 8 — retirement | Remove V1 only after an observation period | Deferred; never part of cutover |

Terraform applies are reviewed per phase. Before cutover, plans should be additive; any EC2, EBS, bucket or V1 state
machine replacement is rejected. V2 workflow names and IAM roles are distinct so a partial apply cannot rewrite the
working control plane.

## Current phase

Phase 2. The pure model is tested and Terraform owns an empty `spawnpoint-lifecycle-v2` DynamoDB table with
pay-per-request billing, encryption, deletion protection and only the `server_id` partition key. No IAM principal can
write it through a V2 role yet; no host script or V1 workflow references it.
