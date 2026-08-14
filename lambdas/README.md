# lambdas

Every piece of code that is not the game server and not the panel. Four groups, kept separate because they
fail for different reasons and have different permissions.

**Lambda is not the orchestrator.** The long operations — start, idle stop, release promotion, world switch — are Step
Functions state machines, and the functions here are their steps. The rule: **if it must answer now, it is a Lambda; if
it takes minutes and can fail halfway, it is a state machine.** Steps hold the real logic — validating a manifest,
verifying an archive, judging a health check — while sequencing, waiting, retrying and rollback live in the machine, and
anything a Lambda would only wrap is a direct service integration instead. See
[ADR-0025](../docs/adr/0025-step-functions-for-long-operations.md).

| Group | Functions | Notes |
| --- | --- | --- |
| Control plane | start, status, releases, promote, backups, restore, logs, link, unlink | Authorises requests, enforces single-flight operation rules and starts Step Functions executions. See [ADR-0012](../docs/adr/0012-web-control-panel.md), [ADR-0019](../docs/adr/0019-account-linking.md) and [ADR-0025](../docs/adr/0025-step-functions-for-long-operations.md) |
| Lifecycle | idle check, post-session backup, and a Spot interruption handler only if [ADR-0027](../docs/adr/0027-spot-request-shape.md) is un-deferred | Scheduled or event-driven. No public surface |
| Pipeline | release validation, health interpretation, client pack build | Domain tasks invoked by a promotion workflow. Host reconciliation runs through SSM. See [ADR-0025](../docs/adr/0025-step-functions-for-long-operations.md) and [ADR-0030](../docs/adr/0030-desired-and-active-release.md) |
| Adapters | Discord interactions, Telegram webhook, event fan-out to both | Verify every request. Never trust the identity in the payload unverified. A bot also issues sign-in links, so these are security-relevant. See [ADR-0016](../docs/adr/0016-chat-integrations.md) and [ADR-0021](../docs/adr/0021-sign-in-from-linked-chat-account.md) |
| Auth | Cognito custom authentication triggers for the bot-issued sign-in link | Verifies one thing: is this token present, unused and unexpired. Keep it that small |

Rules that apply to all of them:

- One IAM role per function, scoped to what that function actually does. No shared "lambda role".
- Reach the instance through SSM Run Command only. No SSH, no VPC attachment, no key material. See
  [ADR-0007](../docs/adr/0007-ssm-instead-of-ssh.md).
- Secrets come from SSM Parameter Store at runtime, never from environment variables in Terraform.
- Anything slow is an operation with observable state, not a long request.
- Domain code depends on explicit storage, event and host-control interfaces. AWS adapters use SDK clients and SSM;
  local integration adapters use LocalStack endpoints and the Docker host agent. Environment selection must not fork
  the business rules or the ASL definition. See [ADR-0031](../docs/adr/0031-first-class-local-control-plane.md).

**Runtime direction: TypeScript on a supported Node.js Lambda runtime.** The state machines themselves remain Amazon
States Language definitions, created by Terraform; TypeScript implements API handlers and task logic, not orchestration
hidden inside application code. Use one runtime across all Lambda groups and pin the exact Node.js version when the
first function lands, because supported Lambda runtimes change over time.

The first domain rule now exists without an AWS adapter: `planBackupRetention` chooses distinct recovery points as
five recent UTC days, two older ISO weeks and two still older UTC months. Malformed inventory fails closed. A later
least-privilege Lambda will list objects, call this pure function, and delete only the returned keys; the game host has
no deletion permission.

The Lifecycle V2 coordination model is likewise pure domain code. It defines session identity, desired versus observed
server state, an expiring lease with a monotonically increasing fencing token, single-watchdog ownership and
conservative idle observations. It is not connected to AWS or the working V1 workflows yet; the additive rollout and
cutover boundary are documented in [`docs/lifecycle-v2-rollout.md`](../docs/lifecycle-v2-rollout.md).

Run its dependency-free tests with `npm test` from this directory. The repository currently exercises them with Node
26; the exact supported Lambda Node runtime remains to be pinned when the first deployable handler is added.

**Status:** backup-retention and Lifecycle V2 coordination domain logic exist and are tested. The first M2 start
workflow uses direct EC2/SSM integrations and therefore needs no task Lambda yet. Deployable lifecycle functions
arrive when a step contains real domain logic; pipeline follows in M3, control-plane surfaces and adapters in M4.
