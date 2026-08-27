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

## The host-idle gate, and the probe's shape: both landed before cutover

Done 2026-08-27, in the order the note asked for — as a Choice while it is cheap, rather than as a migration once V2
carries traffic.

**The gate.** `stop-session.sh` ends by asking `check-host-activity.sh` whether anything else on this host is being
played, and answers through its exit code rather than a line for the machine to parse — the same contract the
player-race refusal already uses: `0` the instance may stop, `4` another game is active so it deliberately keeps
running, `5` the answer could not be read. The V1 stop machine, which is what V2 delegates the actual stop to, gained
the two matching arms: `Host Still Busy` is a **success** (the session stopped and its world is backed up; only the
instance stays up), and `Host Activity Unknown` is a deliberate **failure**, because an unreadable answer treated as
idle is how a second world gets killed under its players. With one game on the host the answer is always `0`, so the
gate changes nothing today.

**Apply order.** The state machine first, the host's repository copy second. The machine ignores exit codes it does
not know about only in the sense that they fall to `Session Stop Failed` — red, instance left running — so a host that
learns to return `4` before the machine understands it would report a failure on a healthy stop.

**The probe.** `check-session-activity.sh` gained `PROBE_FORMAT=json`, and the V2 watchdog now reads
`States.StringToJson(...).playersOnline` instead of splitting stdout and taking the fourth line. The old parse was
never wrong about the game — the probe prints the same keys for every game — but it depended on the order the script
printed them in, and nothing in the repository would have failed when that changed.

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
10. A player found by stop's final recheck cancels that stop and resets the session's idle streak; backup or compute
    failures remain `stopping` for explicit recovery.

The dependency-free implementation and executable examples live in
[`lambdas/src/domain/lifecycle.ts`](../lambdas/src/domain/lifecycle.ts) and
[`lambdas/test/lifecycle.test.ts`](../lambdas/test/lifecycle.test.ts). They contain no AWS SDK imports and make no AWS
calls.

## Atomic rollout phases

| Phase | Change | Production behaviour if work stops there |
| --- | --- | --- |
| 1 — domain model | Pure TypeScript state transitions and invariant tests | V1 remains unchanged and operational |
| 2 — state store | Add an empty DynamoDB table in a saved add-only Terraform plan | V1 ignores the table |
| 3 — coordinator | Deploy a short synchronous TypeScript Lambda implementing conditional DynamoDB transitions | Function is inert; no V1 caller can invoke it |
| 4 — host probe | Add and deploy a read-only structured player-count contract | Existing host lifecycle does not call it |
| 5 — V2 workflows | Create `*-v2` start, stop and watchdog state machines with separate IAM | V1 names remain the owner-script defaults |
| 6 — acceptance | Invoke V2 explicitly with short timings; exercise conflicts, stale sessions and backup ordering | Failures do not redirect V1 traffic |
| 7 — cutover | Change the owner/API resolver default from V1 to V2, retaining an explicit V1 override | One small revert or environment override restores V1 |
| 8 — retirement | Remove V1 only after an observation period | Deferred; never part of cutover |

Terraform applies are reviewed per phase. Before cutover, plans should be additive; any EC2, EBS, bucket or V1 state
machine replacement is rejected. V2 workflow names and IAM roles are distinct so a partial apply cannot rewrite the
working control plane.

## Current phase

Phase 5 is deployed but remains inert. The pure model is tested; Terraform owns the empty protected table and a short
TypeScript coordinator Lambda with consistent reads plus revision-guarded writes. The host now also has the separate
`check-session-activity.sh` contract: only a successfully parsed zero-player RCON response is `idle`; stopped compute,
RCON failure and an unparseable response are `unknown`. No workflow calls the probe yet, no V1 workflow has coordinator
invoke permission, and production lifecycle behaviour remains unchanged. The V2 start, stop and watchdog definitions
now complete the session contract in code: fenced session transitions surround the accepted V1 host operations, and
watchdog observations are idempotent and session-scoped. Their isolated operations-root plan was exactly **9 add / 0
change / 0 destroy**, and the post-apply plan reported `No changes`. The coordinator bundle and V1 stop definition were
then updated independently in two reviewed **0 add / 1 in-place change / 0 destroy** targeted plans. Phase 6 begins by
delivering the matching `stop-session.sh` exit-code contract to the stopped host, before any explicit V2 execution;
V1 remains the owner-script default meanwhile.
