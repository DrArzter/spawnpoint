# lambdas

Every piece of code that is not the game server and not the panel. Twelve deployed functions in seven groups, kept
separate because they fail for different reasons and have different permissions. Before you change the HTTP API, read
[`src/handlers/api/README.md`](src/handlers/api/README.md).

**Lambda is not the orchestrator.** The long operations — start, stop, idle watchdog, host drain, release promotion, world
lifecycle, release build — are Step
Functions state machines, and the functions here are their steps. The rule: **if it must answer now, it is a Lambda; if
it takes minutes and can fail halfway, it is a state machine.** Steps hold the real logic — validating a manifest,
verifying an archive, judging a health check — while sequencing, waiting, retrying and rollback live in the machine, and
anything a Lambda would only wrap is a direct service integration instead. See
[ADR-0025](../docs/adr/0025-step-functions-for-long-operations.md).

| Group | Functions | Notes |
| --- | --- | --- |
| Access API | `spawnpoint-access-api` | Sign-in through Telegram or an email and password, provider-neutral login sessions, the control-plane read model, session control, world creation and lifecycle requests, access management, invitations, subscriptions. One HTTP API, permission-checked per route; the gate order is pinned by a test. See [ADR-0012](../docs/adr/0012-web-control-panel.md), [ADR-0036](../docs/adr/0036-observed-visitors-and-owner-approved-access.md), [ADR-0045](../docs/adr/0045-provider-neutral-login-sessions.md), [ADR-0055](../docs/adr/0055-sign-in-with-email-and-password-by-default.md) |
| Lifecycle V2 | `spawnpoint-lifecycle-coordinator-v2` | Conditional DynamoDB transitions for the fenced session record — leases, sessions, watchdog observations. The rules are pure domain code in `src/domain/lifecycle.ts` |
| Release state | `spawnpoint-release-state` | Prepare, commit, restore and rollback of a wipe's desired/active pointer, with ETag-guarded S3 writes; the promotion machine's only writer. See [ADR-0030](../docs/adr/0030-desired-and-active-release.md) |
| World lifecycle | `spawnpoint-world-lifecycle` | Archive, new wipe, restore into a new wipe, and the guarded permanent purge — the mutation step of the world-lifecycle workflow. See [ADR-0040](../docs/adr/0040-reusable-presets-and-world-wipes.md) |
| Notifications | `spawnpoint-telegram-bot`, `spawnpoint-notifier` | The Telegram command bot, and the notifier that turns execution events and alerts into subscribed Telegram messages plus optional verified-address transactional email through Resend or SES. See [ADR-0016](../docs/adr/0016-chat-integrations.md), [ADR-0020](../docs/adr/0020-email-channel.md) |
| Control-plane view | `spawnpoint-control-plane-projector`, `spawnpoint-control-plane-subscriptions` | The projector rebuilds the stored read model from execution, host and DNS events; the subscriptions function serves the panel's WebSocket that says when to reread it |
| Operations | `spawnpoint-fleet-sweeper`, `spawnpoint-backup-retention` | The sweeper rechecks the launched hosts after a missed or failed drain event and starts the drain a host still needs; retention deletes the backups that `planBackupRetention` no longer keeps |
| Release storage | `spawnpoint-release-reconciler`, `spawnpoint-release-retirement` | The reconciler checks release objects and sweeps condemned files (dry run by default); retirement retires a release no world holds. See [ADR-0080](../docs/adr/0080-store-release-files-by-content.md) |

Rules that apply to all of them:

- One IAM role per function, scoped to what that function actually does. No shared "lambda role".
- Reach the instance through SSM Run Command only. No SSH, no VPC attachment, no key material. See
  [ADR-0007](../docs/adr/0007-ssm-instead-of-ssh.md).
- Secrets come from SSM Parameter Store at runtime, never from environment variables in Terraform.
- Anything slow is an operation with observable state, not a long request.
- Domain code depends on explicit storage, event and host-control interfaces. AWS adapters use SDK clients and SSM.
  Local integration adapters (LocalStack endpoints and a Docker host agent) are planned, not built; `local/` holds only
  its README. Environment selection must not fork the business rules or the ASL definition. See
  [ADR-0031](../docs/adr/0031-first-class-local-control-plane.md).

**Runtime direction: TypeScript on supported Node.js Lambda runtimes.** The state machines themselves remain Amazon
States Language definitions, created by Terraform; TypeScript implements API handlers and task logic, not orchestration
hidden inside application code. Pin each deployed function's runtime explicitly, because supported Lambda runtimes
change over time; runtime convergence can happen separately from this additive integration.

`planBackupRetention` chooses distinct recovery points as five recent UTC days, two older ISO weeks and two still older
UTC months. Malformed inventory fails closed. The deployed `spawnpoint-backup-retention` function
(`src/handlers/backup-retention.ts`) lists the objects, calls this pure function and deletes only the returned keys; the
game host has no deletion permission.

The Lifecycle V2 coordination model is likewise pure domain code. It defines session identity, desired versus observed
server state, an expiring lease with a monotonically increasing fencing token, single-watchdog ownership and
conservative idle observations. It has carried production sessions since the 2026-09-11 cutover; the rollout and its acceptance are documented
in [`docs/lifecycle-v2-rollout.md`](../docs/lifecycle-v2-rollout.md).

Run all checks from this directory. CI runs them with Node 24:

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
has `GetItem` and `PutItem` on the V2 table, `Scan` for the host records that share it (ADR-0054), and write access to
its own bounded log group. No V1 role can invoke it.

## The Telegram bot — the first active control surface

Built on **grammY** (the TypeScript aiogram: router, middleware, typed API), adopted at the owner's call on the
honest observation that restructuring later never happens in an evenings project — the roadmap itself names motivation
as the scarce resource. The recorded costs: one pinned dependency, and the bundle grew from ~9 KB to ~930 KB (esbuild,
ESM, `@aws-sdk/*` externalised — irrelevant at Lambda's limits). What grammY owns, we deleted rather than kept as a
shadow: update parsing and command routing live in the framework, and the former `parseUpdate` is gone with its tests.

The layout is the aiogram shape, mapped onto this project's boundary rule — domain decides, everything else carries:

```
src/domain/telegram-bot.ts   input builders, notification target parsing, reply wording
src/bot/bot.ts               composition root: middleware order, command registry, bot.catch
src/bot/middleware/auth.ts   per-command permission gate backed by the shared access directory
src/bot/commands/*.ts        start / status / info / pack / access / welcome, thin ctx glue
src/bot/services/aws.ts      the AWS port: every SDK call, and the Parameter Store cache
src/bot/handler.ts           cold-start wiring and grammY's aws-lambda-async webhook callback
```

**The builders remain the single source of the canonical timings**, and a test asserts they reproduce
`workflows/*.input.example.json` verbatim. Every start is attributed: `requestedBy: "telegram:<id>"` rides into the one
V2 start execution — the history is the audit record.

Transport decisions worth knowing: the Function URL uses `authorization_type = NONE` because Telegram cannot sign
SigV4 — grammY's `secretToken` option enforces the webhook secret before any handler runs. `bot.catch` absorbs handler
errors into a logged 200, because a non-200 makes Telegram redeliver the update and a broken bot becomes a retry
storm. Secrets come from Parameter Store; authorization comes from the DynamoDB identity, role and direct grants.

### What still grows later

- ~~The notifications leg~~ **Built**: `src/bot/notifier.ts` + `src/domain/notifications.ts`. Step Functions publishes
  every execution's status changes to EventBridge by itself, so the machines carry no announce states — the execution
  lifecycle IS the event, and the domain module's judgement is mostly about *silence*: child executions (the
  watchdog's stops, promotion's children) never double-announce their parents, stop successes are announced by
  whoever ordered them, and a failed stop always speaks because it is the backup contract failing. The notifier's
  role reads the bot parameters (`/spawnpoint/bot/*`) and the email adapter's key, reads the notification
  subscriptions, records invitation delivery on the access table, and sends only from the sender's SES identity. The same function is subscribed to the guardrails
  topic, so the budget, cost anomalies and the running-hours alarm reach the chat too (`src/domain/alerts.ts`); an
  alert must never be lost to a parse error, so unrecognised formats are delivered raw, never thrown.
- ~~**Callbacks and dialogs**~~ **Built**: inline keyboards edit one card in place, and the two-step start confirmation
  is the first dialog. A DynamoDB-backed FSM has not been needed.
- **A second platform** (Discord, [ADR-0016](../docs/adr/0016-chat-integrations.md)): the command cores stay per-platform thin over shared services and domain; the adapter move, same as everywhere else in this design.

**Status:** all twelve functions are deployed. The V2 coordinator has served production since the 2026-09-11 cutover;
the V1 machines keep their direct EC2/SSM integrations as V2's private host adapter. The coordinator runs on
`nodejs24.x`, every other function on `nodejs22.x`.
