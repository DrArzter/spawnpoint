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

`start-server-v2.asl.json.tftpl` is the first inert Lifecycle V2 composition. It does not replace the accepted V1
machine. V1 remains the host operation that starts EC2, waits for SSM and proves Minecraft health; V2 owns the
session-level facts around that operation:

1. initialise the logical server record and acquire its fenced lease;
2. create one explicitly identified session from fully stopped state;
3. run the accepted V1 start synchronously;
4. mark that exact session ready only after V1's health gate, then release the lease;
5. if V1 fails, move the session to stopping, run the accepted verified V1 stop, mark stopped, release the lease and
   fail with `Spawnpoint.V2StartFailedCompensated`.

If both start and compensation fail, the record deliberately remains `stopping` and the execution fails as
`Spawnpoint.V2StartCompensationFailed`; claiming `stopped` without a verified backup and EC2 stop would corrupt the
control plane's evidence. The definition is not wired into Terraform yet. Its input requires distinct `operationId`
and `sessionId` values; operation history and session identity are related, but not interchangeable.

## Stop server

`stop-server.asl.json` invokes the host's indivisible session-close contract, then stops EC2 only after that command
succeeds. The host rechecks zero players, flushes the world, stops all session containers, creates a full archive and
verifies its immutable S3 upload. Any refusal, archive failure or upload mismatch ends the workflow visibly while EC2
remains running for diagnosis. An already-stopped instance is an idempotent successful result.

## Idle watchdog

`idle-watchdog.asl.json` is the sensor in front of that stop. One execution exists per session — started by
`scripts/start-server.sh` alongside the session, so there is no schedule to enable and disable and nothing runs
between sessions ([ADR-0006](../docs/adr/0006-on-demand-start-and-idle-shutdown.md),
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

## Promote release

`promote-release.asl.json` implements [ADR-0030](../docs/adr/0030-desired-and-active-release.md) by composing the
machines above instead of duplicating them. The insight that makes it small: **boot-time reconciliation turned the
pointer into the single control surface**, so promotion is pointer writes around a verified stop and start, and
rollback is the same mechanism in reverse.

1. Read and validate the world's pointer; an already-active release ends idempotently.
2. Verify the target release is published (its manifest exists).
3. **Write desired.** From here every path must leave the pointer telling the truth.
4. Running host → the verified stop (a refusal — players online — restores the pointer and fails as
   `PromotionRefused`; nothing changed). Stopped host → straight to start.
5. The existing start machine runs synchronously: the host reconciles to desired and the health gate proves it.
6. Success → **commit active**. Failure → flip the pointer to the previous active and start again — the host
   reconciles *back* by the same boot-time mechanism — ending `rolled_back`, or `RollbackFailed` if that start
   fails too. A world whose active is null has nowhere to roll back to and fails as `PromotionFailedNoRollback`.
7. A host that was running gets its watchdog relaunched (fire-and-forget; its failure never fails a finished
   promotion). A host that was stopped is stopped again after the commit, so promotion never leaves a paid
   surprise behind.

Every bad ending is a distinct `Spawnpoint.*` error, because "failed" without "where" is midnight archaeology.
Pointer documents are built as objects and passed directly to the S3 SDK integration, which serialises the blob.
Applying `States.JsonToString` here would double-encode the object as a JSON string. Nested Step Functions execution
inputs are different: those integrations explicitly require a string, so their `States.JsonToString` calls remain.

**Known gap, deliberate:** nothing prevents a concurrent promotion and watchdog stop from interleaving. Single-flight
is ADR-0025's open question; until it lands, promote when the session is quiet — the stop machine's player check is
the guard that matters.
