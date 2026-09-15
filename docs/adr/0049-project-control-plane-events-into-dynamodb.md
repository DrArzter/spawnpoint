# ADR-0049 — Project control-plane events into DynamoDB for user-facing surfaces

- Status: Accepted
- Date: 2026-09-15
- Amends: [ADR-0012](0012-web-control-panel.md), which allowed clients to poll live operation state
- Clarifies: [ADR-0025](0025-step-functions-for-long-operations.md), whose executions remain the authoritative operation state

## Context

The access API currently builds every panel snapshot by querying EC2, every relevant Step Functions state machine,
DynamoDB and S3. The panel then polls that fan-out every five seconds while an operation is visible. This is expensive
in failure modes rather than money: an EC2 state change can outlive the workflow that would have made the panel poll,
provider observations arrive at different times, and a manually stopped host can leave a durable lifecycle record
showing `stopping` until somebody explicitly reconciles it.

EventBridge already receives Step Functions execution changes and native EC2 state changes. It delivers at least once
and without aggregate ordering, so neither an event nor its arrival order is authoritative enough to mutate a session
blindly. The panel also cannot and should not connect directly to EventBridge.

## Decision

Spawnpoint records normalized control-plane events and a rebuildable control-plane view in an encrypted, on-demand,
deletion-protected DynamoDB table. EventBridge invokes one projector for relevant EC2 and Step Functions events. The
projector re-reads provider state, records a sanitized event by its immutable event id, and conditionally replaces the
dynamic view only with a newer observation. The access API reads that view for display, while command planning keeps
reading the authoritative providers and Lifecycle V2 records directly.

The view is an optimization and an eventual-consistency boundary, not event sourcing. If it is absent, malformed or
stale, the API falls back to the existing live reads. Step Functions executions remain operations; DynamoDB stores
only their read projection and bounded event history.

An externally stopped host also starts a one-shot deferred reconciliation execution. Relevant terminal operation events
start the same safety net, covering a lifecycle write that fails after EC2 has already emitted its final state change.
The reconciliation waits beyond the longest lease, re-reads EC2, Step Functions and the exact Lifecycle V2 session,
and may invoke the existing fenced stop only for that still-stranded session. A lease-free stopped host is reconciled
immediately. This applies to any exact active session contradicted by a stopped host, including a host stopped outside
Spawnpoint while its lifecycle still says `ready`; no player-facing repair command is required. There is no forever
schedule and no direct `stopped` write from an unordered event.

The panel does not poll while an operation is visible. An approved `status.read` caller exchanges its ordinary HTTP
session for a single-use, one-minute subscription ticket, then opens an API Gateway WebSocket. After successfully
replacing the projection, the projector publishes a normalized `Projection Updated` event; a separate subscription
adapter sends only that invalidation and its observation revision to connected browsers. Opening or reopening the
socket also invalidates the client's cache, so events missed while disconnected are recovered. Clients always fetch
permission-filtered data through the control-plane HTTP API; the socket never carries provider or world state.

## Consequences

- A dashboard refresh normally becomes one DynamoDB read for dynamic state instead of EC2 plus several Step Functions
  calls, while lifecycle decisions remain fail-closed against live state.
- Duplicate and late events are harmless: event ids deduplicate history and observation revisions fence the projection.
- WebSocket tickets are single-use and contain no bearer credential; connection and ticket records expire through the
  existing DynamoDB TTL. Revoking access prevents the next HTTP snapshot even if an invalidation reaches an old socket.
- Event records are sanitized and expire; they are operational history, not a second permanent source of truth.
- The view can lag EventBridge and must visibly retain its observation time. The live-read fallback is required during
  rollout and whenever the projection exceeds its freshness window.
- EventBridge does not replace Step Functions. Chaining lifecycle mutations through unordered events would lose the
  execution history, rollback and fencing guarantees recorded in ADR-0025.

## Alternatives considered

| Option | Why not chosen |
| --- | --- |
| Keep provider fan-out polling | Simple, but it already failed to observe an external stop after the operation disappeared |
| Let the browser subscribe directly to infrastructure events | EventBridge is not a browser transport, and raw events bypass API authorization and redaction |
| Send complete snapshots over WebSocket | Duplicates authorization and redaction in a second API; invalidation keeps the permission-filtered HTTP read as the only user-facing state contract |
| Make the event log the write model | A much larger event-sourcing migration with no current benefit; Lifecycle V2 and Step Functions already own correct writes |
| Run a periodic reconciliation Lambda forever | Cheap but contradicts the session-scoped, event-driven shape; a one-shot delayed execution handles an active lease without permanent polling |
