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

Phase 7 cut over on 2026-09-11. A direct production acceptance first exercised
`starting → ready → stopping → stopped` with one session ID and fenced leases. The verified stop uploaded a
419,378,199-byte world archive before EC2 stopped. The panel then started the same world through the deployed Access
API, proving that the public path resolves `spawnpoint-start-server-v2`; that wrapper now launches the one V2 watchdog
only after readiness and compensates with a verified stop if the watchdog cannot be launched.

The panel, Telegram bot and owner scripts now call only V2 start/stop entry points. V1 remains deployed as the private
host adapter composed by V2; it is no longer a user-facing resolver. World archive/regenerate operations pass the
active session ID through the same V2 verified stop instead of bypassing lifecycle state.

Release promotion composes only Lifecycle V2 start and stop. The promotion workflow reads the authoritative lifecycle
record before touching the host, stops the exact active session, and gives target and rollback starts distinct session
identities. Lifecycle V2 start owns watchdog registration, so promotion has no watchdog bypass or watchdogless success
path.

## Phase 8 acceptance: V2 release promotion

Production promotion moved to Lifecycle V2 on 2026-09-11 in commit `3e3adb1`. The saved operations plan contained
exactly two in-place updates — the promotion role policy and state-machine definition — and no additions or
destructions. A fresh plan after apply reported `No changes`.

The first smoke execution, `promote-20260911T234331Z`, targeted the already-active release `1.1`. It returned
`already_active` without changing lifecycle revision `23` or starting EC2. Two stopped-origin executions then
exercised the complete composition:

- `promote-20260911T234437Z` promoted `1.1 → 34246388450.1`, started a new fenced target session, passed health and
  required watchdog registration, committed active, archived the wipe, and stopped that exact session;
- `promote-20260911T234937Z` repeated the same path to restore `34246388450.1 → 1.1`.

The verified archives were
`world-gen-5ef02ba44b4796544786716f89d2e10b-20260911T234833Z-babc578e277684f7fef2356b62d7e2c2974a4d9b0d6690c0e26a8b9f806ae8a0.tar.zst`
and
`world-gen-5ef02ba44b4796544786716f89d2e10b-20260911T235231Z-07ff1556eae6ad1d0fbbc23dd0d4d7e10b2a5177a971a069214fc551a28701db.tar.zst`.
Afterward the wipe pointer read `desired_release=active_release=1.1`, lifecycle revision `45` was
`stopped/stopped` with no active session or lease, and EC2 was stopped.

The drill also caught a clean-handoff reporting defect. The first target watchdog woke while the second target
session was already stopping: its fenced stop correctly returned `V2StaleSession`, but the watchdog reported that
safe loss of ownership as a failure. All watchdog stop branches now terminate successfully as
`session_superseded` for that one error; backup, host-stop and unknown failures remain loud. The second watchdog,
which woke after lifecycle was fully stopped, completed through the existing idempotent path without changing
revision `45`.

The first cutover run also exposed the expected duplicate-stop edge: a user stopped the session before its watchdog's
next probe, then the watchdog observed stopped EC2 and repeated the exact stop. V2 stop now reads lifecycle before
acquiring a lease, returns `already_stopped` without mutation for a closed server, and rejects a stale session before
it can take a lease. Production idempotency acceptance returned `SUCCEEDED / already_stopped`; the leaked pre-fix lease
was taken over with fencing token 7 and released, leaving `desired=stopped`, `observed=stopped`, no session and no lease.

Phase 8 retirement is deliberately deferred until the observation period proves no hidden caller still invokes a V1
ARN. All three isolated Terraform roots reported `No changes` immediately after cutover.
