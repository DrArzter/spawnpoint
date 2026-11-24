# ADR-0092 — A Lambda entry is its composition root

- Status: Accepted
- Date: 2026-11-24
- Milestone: M6
- Relates: [ADR-0091](0091-the-access-table-is-a-port.md)

## Context

After the access feature moved behind its table port, fourteen files still called the AWS SDK directly: the worker
Lambdas' entries (lifecycle coordinator, world lifecycle, projector, WebSocket subscriptions, fleet sweeper, backup
retention, release state and reconciler), the release writer's entry, the API's subscription ticket, and two
release-path modules that held their DynamoDB and Route53 calls beside their rules.

## Decision

- A Lambda entry (`handlers/*.ts`, the bot's handler and notifier, `builder/*-main.ts`) is its composition root. It
  may construct SDK clients and pass them to adapters; it imports no command and sends nothing.
- Every command lives in an adapter file named for what it adapts: `dynamo-table.ts` (the generic table port of
  ADR-0091), `dynamo-lifecycle-stores.ts`, `s3-world-objects.ts`, `s3-backup-retention.ts`, `aws-release-metrics.ts`,
  `aws-fleet-ops.ts`, `aws-event-bus.ts`, `aws-websocket-connections.ts`, `aws-dns-ledger.ts`,
  `dynamo-release-refs.ts`.
- Rules that lived beside the calls stay where the rules belong: `backup-retention.ts`, `release-refs.ts`,
  `dns-ledger.ts`, `release-metrics.ts`.

## Consequences

- The module-boundary test has no legacy list: any non-adapter importing the SDK fails, and an entry that takes
  anything but a client from it fails.
- The audits that look for writes follow the calls: the holder-writer table counts writes through the world-objects
  port, and the reconciler's metric put is checked in its adapter.
