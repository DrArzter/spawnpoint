# ADR-0104 — The tables send the panel's reload message

- Status: Accepted
- Date: 2026-11-27
- Milestone: M6
- Amends: [ADR-0049](0049-project-control-plane-events-into-dynamodb.md) — who tells open panels to reload

## Context

An open panel reads its snapshot again when the WebSocket says `control-plane-invalidated` (ADR-0049). Until now
that message went out only when some code called EventBridge `PutEvents`: the projector published
`Projection Updated`, and since #331 the lifecycle coordinator and the Spot handler published `Session Changed`.
A rule sent both to the subscriptions Lambda, which posted to every connection.

Each writer had to remember to publish. A path that forgot left the panel on the old state: a session that turned
ready in the middle of a workflow, or a Spot warning that turned a world moving with no workflow running. #331 closed
those paths one by one and added a poll in the panel (5 s while something is in transition, 15 s after ten minutes,
off after thirty) as the safety net. The next writer to the same records would open the same gap again.

## Decision

**The tables that hold what the panel shows emit their own changes, through DynamoDB Streams.** Every write reaches
the stream, whichever code made it. No writer publishes a reload message any more.

| Table | Stream view | Filter passes | Why this view |
| --- | --- | --- | --- |
| `spawnpoint-lifecycle-v2` | `NEW_AND_OLD_IMAGES` | an item whose new image (or, on a delete, old image) holds `lifecycle.observedState` | the handler compares the old and new record |
| `spawnpoint-control-plane-view` | `KEYS_ONLY` | the key `PROJECTION#CONTROL_PLANE` / `DYNAMIC` only | the key is all the filter needs |

1. **Each stream goes straight to the subscriptions Lambda** through an event source mapping, with no Pipe and no
   bus between them. The mappings live in `infra/terraform-access-api` beside the Lambda; the streams are enabled in
   the roots that own the tables (`infra/terraform`, `infra/terraform-storage`), which apply first.
2. **The filter drops what the panel never shows.** Subscription tickets, connections, the event journal, host
   records, DNS ledger entries and session history pass nothing. A connection write therefore cannot trigger a
   fan-out, which would otherwise loop.
3. **The handler drops what a filter cannot see.** An event filter cannot compare the old image with the new one, so
   a lease, a fencing token, a player count or an `updatedAt` change on a session record passes the filter. The
   handler maps each record to its reload target (the projection, or the record's key: a game id or `world#<id>`) and
   keeps a session record only when `observedState`, `desiredState`, `activeSessionId`, `activeWorldId` or
   `activeSessionAddress` changed. It removes duplicates in the batch and, since the message names nothing, posts it
   once per batch. The mapping is `lambdas/src/control-plane/panel-changes.ts`; the stream shape is read by the
   adapter `dynamo-stream-changes.ts`.
4. **One path per message.** The `Projection Updated` and `Session Changed` publishers, their `events:PutEvents`
   grants and the EventBridge rule are removed.
5. **The poll becomes a safety net.** It reads every 30 s while something is in transition, keeps the thirty-minute
   stop, reads nothing while the tab is hidden, and starts again when what is in transition changes.

### Failure handling

| Failure | What happens | Who learns of it |
| --- | --- | --- |
| A post to one connection fails | the others are still told; the batch fails at the end | the Lambda `Errors` alarm |
| A batch fails | retried up to 3 times, bisected to isolate a bad record | — |
| It still fails, or a record is older than 10 min | the batch's description goes to `spawnpoint-panel-stream-failures` (SQS, 14 days) | `spawnpoint-panel-stream-failures` alarm |
| The mapping falls behind | — | `spawnpoint-panel-stream-iterator-age` alarm, above 60 s |
| A message is lost anyway | the panel's 30 s poll reads the snapshot | — |

A lost message costs a panel at most one poll interval. A late one is harmless: the panel reloads a snapshot that is
at least as new.

## Costs

Measured with `ConsumedWriteCapacityUnits`, 13 to 27 November 2026 (14 days, read-only CloudWatch):

| Table | Write units, 14 days | Busiest day |
| --- | --- | --- |
| `spawnpoint-lifecycle-v2` | 1,048 | 232 |
| `spawnpoint-control-plane-view` | 7,922 | 1,736 |

Write units are not item counts: a large projection item costs more than one unit per write. So the stream records
are at most this many, and the filters pass fewer.

- **Stream reads by Lambda: no charge.** The DynamoDB on-demand pricing page says that GetRecords calls invoked
  through DynamoDB triggers on AWS Lambda are not charged, unless the function runs on Lambda Managed Instances; ours
  does not (<https://aws.amazon.com/dynamodb/pricing/on-demand/>, read 2026-11-27).
- **Enabling a stream:** the pricing page names no charge for it. That is an absence, not a stated price: not
  verified.
- **Filtered-out records:** the Lambda event filtering page says that a record that fails the filter is skipped and
  the iterator moves past it, but does not state the billing
  (<https://docs.aws.amazon.com/lambda/latest/dg/invocation-eventfiltering.html>). We assume such a record is not an
  invocation. Not verified.
- **Invocations:** at the volume above, a few hundred short invocations a day: well inside the free tier, and fewer
  than the `PutEvents` calls and EventBridge invocations they replace.
- **KMS:** none. The tables use the AWS owned key (ADR-0101), so the streams make no KMS request. The dead-letter
  queue uses SQS-managed encryption, also without KMS.
- **Panel reads:** fewer. The poll reads at most every 30 s instead of every 5 s.

## Consequences

- A new writer to a session record or to the projection reaches the panels with no code of its own.
- The panel learns of a change within about a second of the write, not only when a workflow starts or ends.
- The view table's stream holds keys only, so no `identity_id` of a ticket or connection enters it. The lifecycle
  stream holds full images for 24 hours; those records carry session and world ids and a game address, no personal
  data. Only the subscriptions Lambda may read either stream: `dynamodb:DescribeStream`, `GetRecords` and
  `GetShardIterator` on the two stream ARNs, and `dynamodb:ListStreams`, which IAM accepts only on `*`.
- A plan made before the streams exist plans no mapping; the `panel_streams_are_enabled` check says so. The
  production deploy applies the table roots first, so its plan of the access API sees both streams.
- The deploy identity may now create and update event source mappings and create, configure and tag `spawnpoint-*`
  SQS queues. It still deletes neither.
- Changing a stream's view type later needs the stream disabled first, which gives it a new ARN and a new mapping.
- Host records do not reach the panel this way. The panel shows hosts from the projection, which EC2 events update.
