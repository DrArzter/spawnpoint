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

**Runtime direction: TypeScript on supported Node.js Lambda runtimes.** The state machines themselves remain Amazon
States Language definitions, created by Terraform; TypeScript implements API handlers and task logic, not orchestration
hidden inside application code. Pin each deployed function's runtime explicitly, because supported Lambda runtimes
change over time; runtime convergence can happen separately from this additive integration.

The first domain rule now exists without an AWS adapter: `planBackupRetention` chooses distinct recovery points as
five recent UTC days, two older ISO weeks and two still older UTC months. Malformed inventory fails closed. A later
least-privilege Lambda will list objects, call this pure function, and delete only the returned keys; the game host has
no deletion permission.

The Lifecycle V2 coordination model is likewise pure domain code. It defines session identity, desired versus observed
server state, an expiring lease with a monotonically increasing fencing token, single-watchdog ownership and
conservative idle observations. It is not connected to AWS or the working V1 workflows yet; the additive rollout and
cutover boundary are documented in [`docs/lifecycle-v2-rollout.md`](../docs/lifecycle-v2-rollout.md).

Run all checks from this directory. The repository currently exercises them with Node 26:

The Lifecycle V2 coordinator targets the AWS-supported `nodejs24.x` runtime and
bundles its pinned AWS SDK v3 clients with esbuild. Because development environments may set `NODE_ENV=production`,
install build tooling explicitly before producing the deterministic ZIP:

```bash
npm ci --include=dev
npm run typecheck
npm test
npm run build
```

The coordinator performs consistent reads and revision-guarded `PutItem` calls against one lifecycle item. Conditional
write loss causes a bounded reread/retry; Step Functions still owns every wait and long operation. Its production role
has only `GetItem`, `PutItem` on the V2 table and write access to its own bounded log group. No V1 role can invoke it.

## The Telegram bot — the first active control surface

Built on **grammY 1.45.1** (the TypeScript aiogram: router, middleware, typed API), adopted at the owner's call on the
honest observation that restructuring later never happens in an evenings project — the roadmap itself names motivation
as the scarce resource. The recorded costs: one pinned dependency, and the bundle grew from ~9 KB to ~930 KB (esbuild,
ESM, `@aws-sdk/*` externalised — irrelevant at Lambda's limits). What grammY owns, we deleted rather than kept as a
shadow: update parsing and command routing live in the framework, and the former `parseUpdate` is gone with its tests.

The layout is the aiogram shape, mapped onto this project's boundary rule — domain decides, everything else carries:

```
src/domain/telegram-bot.ts   allow-list (strict: malformed ids throw), input builders, reply wording
src/bot/bot.ts               composition root: middleware order, command registry, bot.catch
src/bot/middleware/auth.ts   the allow-list gate — commands only, so strangers' chatter is never answered
src/bot/commands/*.ts        start / status / pack, thin ctx glue
src/bot/services/aws.ts      the AWS port: every SDK call, and the Parameter Store cache
src/bot/handler.ts           cold-start wiring and grammY's aws-lambda-async webhook callback
```

**The builders remain the single source of the canonical timings**, and a test asserts they reproduce
`workflows/*.input.example.json` verbatim. Every start is attributed: `requestedBy: "telegram:<id>"` rides into both
execution inputs — the history is the audit record, the notifications leg will read it for "X requested the server".

Transport decisions worth knowing: the Function URL uses `authorization_type = NONE` because Telegram cannot sign
SigV4 — grammY's `secretToken` option enforces the webhook secret before any handler runs. `bot.catch` absorbs handler
errors into a logged 200, because a non-200 makes Telegram redeliver the update and a broken bot becomes a retry
storm. Secrets come from Parameter Store: token and webhook secret cached for the container's life, the allow-list on
a 60-second TTL so `put-parameter --overwrite` takes effect without a redeploy.

### What still grows later

- ~~The notifications leg~~ **Built**: `src/bot/notifier.ts` + `src/domain/notifications.ts`. Step Functions publishes
  every execution's status changes to EventBridge by itself, so the machines carry no announce states — the execution
  lifecycle IS the event, and the domain module's judgement is mostly about *silence*: child executions (the
  watchdog's stops, promotion's children) never double-announce their parents, stop successes are announced by
  whoever ordered them, and a failed stop always speaks because it is the backup contract failing. The notifier's
  role reads exactly two parameters and can do nothing else. The same function is subscribed to the guardrails
  topic, so the budget, cost anomalies and the running-hours alarm reach the chat too (`src/domain/alerts.ts`); an
  alert must never be lost to a parse error, so unrecognised formats are delivered raw, never thrown.
- **Callbacks and dialogs**: grammY keyboards plus the first FSM state — a DynamoDB row behind a storage port, which
  [ADR-0031](../docs/adr/0031-first-class-local-control-plane.md) requires for the local environment anyway.
- **A second platform** (Discord, [ADR-0016](../docs/adr/0016-chat-integrations.md)): the command cores stay per-platform thin over shared services and domain; the adapter move, same as everywhere else in this design.

**Status:** backup-retention, Lifecycle V2 coordination, Telegram bot, notifications and alert handling exist and are
tested. The V2 coordinator is deployable but remains inert until separate V2 workflow roles receive invoke permission;
V1 continues to use direct EC2/SSM integrations. The bot and notifier are active M4 surfaces on `nodejs22.x`.
