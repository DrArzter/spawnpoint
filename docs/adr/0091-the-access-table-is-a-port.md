# ADR-0091 — The access table is a port

- Status: Accepted
- Date: 2026-11-24
- Milestone: M6
- Relates: [ADR-0090](0090-game-rules-live-in-the-module.md); `lambdas/test/module-boundaries.test.ts`

## Context

Twenty files of the access feature (sessions, profiles, passwords, OAuth, invitations, identity deletion and the
rules that build access writes) imported the AWS SDK. About eighty call sites built DynamoDB commands in the handlers
themselves, beside EventBridge and S3 calls. The module-boundary test listed every one of them as a legacy exception.

## Decision

- `access/table.ts` declares the access table's port: `AccessTable` (get, put, update, delete, query, scan,
  transact) over inputs in the shape DynamoDB's document client takes. The access rules build writes with these
  types; they import no SDK.
- `handlers/api/access-store.ts` is the port's adapter over the document client; handlers call `accessTable`.
- Events go through `aws-events.ts` (`publishEvent`), avatars through `s3-avatars.ts`, secrets and mail through
  `aws-secrets.ts` and `aws-mail.ts`; the bot's two stores are named as stores.
- The port returns items as the document client types them (`any` attributes), so no reader changed in this step.

The port is table-shaped, not one method per access operation. That keeps this change mechanical and the tests'
table fake unchanged; a feature that needs a narrower port can still grow one on top.

## Consequences

- No access file imports the SDK; the legacy list shrinks from 34 to 14 entries, all Lambda entries and
  release-path adapters.
- A test can give a handler an in-memory `AccessTable` instead of patching the client.
