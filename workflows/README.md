# workflows

Amazon States Language definitions for operations that take minutes and can fail halfway. These are Standard Step
Functions workflows. TypeScript implements synchronous handlers and domain decisions; it does not hide orchestration
loops inside Lambda.

## Build release

`build-release.asl.json.tftpl` accepts exactly the release identity — profile ID, full configuration Git SHA and
`MAJOR.MINOR` release — and starts the one Terraform-owned CodeBuild project through the synchronous optimized service
integration. The project name is rendered into the definition, never accepted from a caller. The workflow passes no
CurseForge key, bucket, source bundle or buildspec override; CodeBuild receives the key directly from Parameter Store
and all other authority from its own role.

Missing or non-string fields fail before a build. Exact format validation happens again in the builder, which can use
regular expressions and refuses moving Git refs. A successful job returns `READY`; a failed job fails the execution as
`Spawnpoint.ReleaseBuildFailed`. Neither path writes a world pointer or starts EC2, so building remains distinct from
promotion.

## Start server

`start-server.asl.json` is the first M2 vertical slice:

1. inspect the configured EC2 instance and start it only when stopped;
2. wait for EC2 `running` without occupying a Lambda;
3. wait for the SSM agent to be Online;
4. send the constant, non-user-controlled host command `start-session.sh`;
5. poll the SSM invocation until it succeeds or reaches a terminal failure;
6. return `ready` only after the host script has verified ZeroTier and Minecraft health.

The operation input supplies poll intervals so local integration can run with short waits while production uses sane
intervals. Poll limits make every loop bounded. `instanceId` and `connectionAddress` are supplied by the trusted
control-plane trigger; the Step Functions IAM role is still scoped to the one Terraform host.

The SSM command deliberately contains no interpolated execution input. ZeroTier network identity and expected address
come from the root-owned, mode-`0600` host `.env`; this prevents a crafted operation input from becoming shell syntax.

The definition currently stops visibly on failure. Automatic EC2 compensation after a failed start is the next slice:
it must first distinguish an instance that this execution started from one that was already running, otherwise a
failed health check could stop somebody else's active session.

## Start server V2

`start-server-v2.asl.json.tftpl` is the public Lifecycle V2 composition. V1 remains the private host operation that
starts EC2, waits for SSM and proves game health; V2 owns the
session-level facts around that operation:

1. initialise the logical server record and acquire its fenced lease;
2. create one explicitly identified session from fully stopped state;
3. run the accepted V1 start synchronously;
4. mark that exact session ready only after V1's health gate, then release the lease;
5. launch the session-scoped V2 watchdog; if launch itself fails, reacquire a fenced lease and perform a verified stop;
6. if V1 fails, move the session to stopping, run the accepted verified V1 stop, mark stopped, release the lease and
   fail with `Spawnpoint.V2StartFailedCompensated`.

If start/watchdog launch and compensation both fail, the record deliberately remains `stopping` and the execution fails as
`Spawnpoint.V2StartCompensationFailed`; claiming `stopped` without a verified backup and EC2 stop would corrupt the
control plane's evidence. The definition is deployed from `infra/terraform-operations` and has carried production
traffic since the 2026-09-11 cutover ([docs/lifecycle-v2-rollout.md](../docs/lifecycle-v2-rollout.md)). Its input
requires distinct `operationId` and `sessionId` values; operation history and session identity are related, but not
interchangeable.

`stop-server-v2.asl.json.tftpl` provides the matching session-level stop contract. It first returns `already_stopped`
without a write for a closed server and rejects a stale session before it can acquire a lease. Otherwise it acquires a fenced lease for the
exact active `sessionId`, moves it to `stopping`, and holds authority while the accepted V1 stop rechecks players,
saves, verifies the S3 archive and stops EC2. Only then does it mark the session stopped and release the lease. A V1
failure leaves the truthful `stopping` state in place so a later operation can retry; it never converts uncertainty
into a false success. The one non-fault outcome is `Spawnpoint.PlayersOnline`: V2 cancels that stop, restores `ready`,
resets the session's empty streak and releases the lease before returning a distinct refusal.

## Stop server

`stop-server.asl.json` invokes the host's indivisible session-close contract, then stops EC2 only after that command
succeeds. The host rechecks zero players, flushes the world, stops all session containers, creates a full archive and
verifies its immutable S3 upload. Any refusal, archive failure or upload mismatch ends the workflow visibly while EC2
remains running for diagnosis. An already-stopped instance is an idempotent successful result.

A player appearing during the final recheck is the distinct `Spawnpoint.PlayersOnline` failure. The host script uses
exit code `3` for this expected race; save and backup faults retain ordinary failure codes. Lifecycle V2 uses that
distinction to return the same session from `stopping` to `ready`, rather than leaving a healthy occupied server in a
stuck lifecycle state.

## Idle watchdog

`idle-watchdog.asl.json` is the V1 sensor in front of that stop; since the 2026-09-11 cutover the V2 start launches
`idle-watchdog-v2` itself. One execution exists per session — started with the session, so there is no schedule to
enable and disable and nothing runs between sessions ([ADR-0006](../docs/adr/0006-on-demand-start-and-idle-shutdown.md),
[ADR-0025](../docs/adr/0025-step-functions-for-long-operations.md)). The loop: wait, confirm the host is still
running, probe `idle-probe.sh` over SSM, and count.

- The probe is an **exit-code contract** — 0 empty, 3 occupied, anything else a probe failure — so the workflow never
  parses RCON output.
- After `emptyChecksRequired` consecutive empty checks it runs the **verified stop workflow synchronously** and ends.
  A refused stop (players raced back in) resets the streak and resumes watching.
- A failed probe **never counts as empty**; after `maxConsecutiveProbeFailures` the execution fails loudly as
  `Spawnpoint.WatchdogBlind` — deliberately leaving EC2 running, because a blind watchdog must not stop a possibly
  occupied server.
- `maxTotalChecks` is the **hard session cap** (default 96 × 5 min = 8 h): the only guard that survives somebody
  being online who should not be.
- A host stopped by anything else ends the watchdog as a success, not an error.

All intervals and limits arrive in the input, so an acceptance drill can run with a two-minute threshold while
production uses fifteen. The running-hours CloudWatch alarm is the backstop behind the whole mechanism.

`idle-watchdog-v2.asl.json.tftpl` moves coordination facts out of execution-local counters. The execution registers
itself against one exact `sessionId`; every structured player observation is written through the coordinator with the
SSM command ID as its idempotency key. Successful zero-player reads alone advance DynamoDB's empty streak. A positive
count or an unknown probe resets it, and only the coordinator's `isIdleStopEligible` decision can enter the V2 stop.
The final stop still rechecks players: its expected player-race refusal returns to the loop, while a backup or compute
failure ends loudly. A stale watchdog fails its coordinator mutation before it can start a stop for a newer session.

## Promote release

`promote-release.asl.json` implements [ADR-0030](../docs/adr/0030-desired-and-active-release.md) by composing Lifecycle
V2 instead of duplicating it. The insight that makes it small: **boot-time reconciliation turned the wipe's release
pointer into the single control surface**, so promotion is pointer writes around a fenced, verified stop and start, and
rollback is the same mechanism in reverse. Since 2026-09-11 the pointer writes are one Lambda, `spawnpoint-release-state`,
whose transitions — prepare, commit, restore, rollback — are pure TypeScript in
`lambdas/src/control-plane/release-state-transitions.ts`, written with optimistic concurrency on the S3 object's ETag.
The machine never builds a pointer document itself.

1. Verify the target release is published for this game and preset (its manifest exists).
2. **Prepare**: write desired for the world's current wipe; an already-active release ends idempotently. From here
   every path must leave the pointer telling the truth.
3. Read the authoritative lifecycle record. Ready with an active session → the fenced V2 stop of *that* session (a
   refusal — players online — restores the pointer and fails as `PromotionRefused`; nothing changed). Fully stopped →
   straight to start. Anything else → restore the pointer and fail as `LifecycleUnavailable`.
4. The V2 start runs synchronously with a fresh session identity: the host reconciles to desired, the health gate
   proves it, and V2 registers the watchdog — promotion has no watchdog bypass and no watchdogless success.
5. Success → **commit active**. Failure → **rollback**: flip the pointer to the previous active and start again in a
   second fresh session — the host reconciles *back* by the same boot-time mechanism — ending `rolled_back`, or
   `RollbackFailed` if that start fails too. A wipe whose active is null has nowhere to roll back to and fails as
   `PromotionFailedNoRollback`.
6. A host that was stopped is stopped again after the commit or the rollback, so promotion never leaves a paid surprise
   behind; a host that was running stays running with its new session.

Every bad ending is a distinct `Spawnpoint.*` error, because "failed" without "where" is midnight archaeology. Nested
execution inputs are passed as objects to `states:startExecution.sync:2`, which serialises them. The interleaving gap
this section used to record — a promotion racing a watchdog stop — is serialised by the fenced lease: both hold the
server's lease while they mutate lifecycle state, and a stale session cannot ([docs/lifecycle-v2-rollout.md](../docs/lifecycle-v2-rollout.md),
invariants 1–3 and 8). The production acceptance of 2026-09-11 is recorded there.

## The probe contract — resolved 2026-08-27

**Done before cutover**, in the shape this note asked for: `check-session-activity.sh` offers `PROBE_FORMAT=json`, and
the V2 watchdog reads `States.StringToJson(...).playersOnline` from the whole of stdout, so there is no position and no
order to depend on ([docs/lifecycle-v2-rollout.md](../docs/lifecycle-v2-rollout.md)). The note stays as written, because
the trap it describes is the general one.

`check-session-activity.sh` speaks `key=value` lines, and the V2 watchdog extracts `players_online` with string
intrinsics **by line position** — `ArrayGetItem(StringSplit(stdout, '\n'), 3)`, the fourth line.

Audited on 2026-08-27, when the adapter landed and a second game entered the catalog. The parse is **not** broken by
the game axis: the probe prints the same four single-line keys for every game, because the count comes from
`game_parse_player_count` rather than from a game's own wording. What it is fragile to is line *order* — adding or
reordering a key in that script silently changes which value the machine reads, and nothing in the repository fails
when it does.

The same audit fixed two things the axis really had missed — readiness in `start.sh` and the control-path check in
`status.sh`, both of which called Minecraft's in-container `rcon` CLI and could never have started a Factorio
session — and moved the raw player-query text in `players.sh`/`status.sh` to a single line, because Factorio's answer
spans several and a multi-line value in a `key=value` stream is the next version of this same trap.

The fix at cutover is not a smarter split: it is for the probe to offer a JSON document and for the machine to use
`States.StringToJson` on the whole of stdout, so there is no position and no order to depend on. Recorded here, with
the tftest and the node test that assert the current expression, so the implementer inherits the warning rather than
the incident.
