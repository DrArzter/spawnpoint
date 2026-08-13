# workflows

Amazon States Language definitions for operations that take minutes and can fail halfway. These are Standard Step
Functions workflows. TypeScript implements synchronous handlers and domain decisions; it does not hide orchestration
loops inside Lambda.

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

## Stop server

`stop-server.asl.json` invokes the host's indivisible session-close contract, then stops EC2 only after that command
succeeds. The host rechecks zero players, flushes the world, stops all session containers, creates a full archive and
verifies its immutable S3 upload. Any refusal, archive failure or upload mismatch ends the workflow visibly while EC2
remains running for diagnosis. An already-stopped instance is an idempotent successful result.
