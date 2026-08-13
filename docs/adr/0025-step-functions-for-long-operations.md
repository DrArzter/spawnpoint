# ADR-0025 — Long operations are Step Functions state machines; Lambda handles the synchronous work and the steps

- Status: Accepted
- Date: 2026-08-11
- Milestone: M2
- Amends: [ADR-0012](0012-web-control-panel.md), whose open question about where operation state lives this answers
- Refines: [ADR-0009](0009-s3-as-mod-source-of-truth.md), which described the promotion sequence without saying what runs it

## Context

Step Functions is not an alternative to Lambda. It is an orchestrator: it sequences steps, and the steps are usually
Lambda functions or direct calls to AWS services. The real question is which parts of this system should be a state
machine instead of a Lambda writing its own control flow.

Four operations here are long, multi-step, and must survive partial failure:

| Operation | Shape |
| --- | --- |
| Start | Start instance → wait for running → publish connection string → wait for container healthy → ready |
| Idle stop | Save → verify save → stop container → archive → verify archive → stop instance |
| Release promotion | Validate → announce → save → stop → reconcile → start → health check → move pointer and build pack, **or roll back** |
| World switch | Stop one world with its archive, then start another |

Written as Lambda functions, each becomes one of two bad shapes. Either a single long-running function, which risks
the 15-minute execution limit — a modded server start plus a health check plus a mod sync is not obviously inside
it — or a hand-rolled state machine in DynamoDB with self-invocations and a status column, which is Step Functions
reimplemented badly.

Two details make the choice sharper than a general preference for tidiness:

1. **Waiting in Lambda is billed; waiting in a state machine is not.** Polling for three minutes for a server to come
   up costs three minutes of Lambda duration. A `Wait` state costs nothing. This matters for the invariant in
   [docs/architecture.md](../architecture.md#what-runs-when-nobody-plays): a state machine waiting is genuinely
   nothing running, whereas a polling Lambda is a process in all but name.
2. **[ADR-0012](0012-web-control-panel.md) needs operation state anyway.** If a state machine runs the operation, its
   execution *is* the state — which removes a store rather than adding a service.

## Decision

**Step Functions runs the four long operations.** Standard workflows, one state machine per operation type.

**Lambda keeps everything synchronous or single-step**: the API handlers, the chat interaction and webhook endpoints,
the notification adapters, and the individual task steps inside the state machines. Anything that must answer a caller
immediately stays a plain function — [ADR-0016](0016-chat-integrations.md) has a few seconds to acknowledge a Discord
interaction, and an orchestrator has no business in that path.

The division, stated as a rule: **if it must answer now, it is a Lambda. If it takes minutes and can fail halfway, it
is a state machine.**

**The execution is the operation.** The execution identifier is the operation identifier that
[ADR-0012](0012-web-control-panel.md) hands back to the surfaces, and its current state is read from the execution
rather than from a table. This removes the DynamoDB table for operation state; the link table from
[ADR-0019](0019-account-linking.md) and the short-lived token tables from
[ADR-0021](0021-sign-in-from-linked-chat-account.md) are unaffected, because those are not operation state.

**Standard, not Express.** Express workflows are cheaper at volume, but they are capped at five minutes and give
at-least-once execution semantics. Our operations exceed five minutes and must not run twice — promoting a release
twice, or archiving over a good backup, are exactly the outcomes to design out.

**Direct service integrations where a Lambda would only be a wrapper.** Starting an instance, sending an SSM command,
publishing to SNS and writing the live pointer are service calls the state machine can make itself. Task Lambdas are
for steps with real logic: validating a manifest, verifying an archive, interpreting a health check.

Retries and the rollback path become configuration rather than code: backoff on the health check, a catch that routes
a failed promotion to the rollback branch.

## Consequences

**Good**

- The 15-minute Lambda limit stops being a design constraint on the slowest, least predictable operation in the system.
- Retry with backoff and the compensating rollback in [ADR-0009](0009-s3-as-mod-source-of-truth.md) are declared, not
  hand-written, so they are far more likely to be correct.
- A stuck operation is visible in the execution history, at the step where it stuck. This is what
  [ADR-0009](0009-s3-as-mod-source-of-truth.md) meant by "a stuck pipeline is visible rather than silent".
- One store fewer, because the execution replaces the operation table.
- Less code overall: several would-be Lambdas become direct service calls.
- Waiting is free, which keeps the no-fixed-compute invariant honest rather than nominal.
- The execution history is an audit trail of what the system did to itself, alongside CloudTrail's record of who asked.

**Bad, or risky**

- A second place where logic lives. "Where is this rule?" now has two possible answers, and the boundary has to be
  respected or it becomes three.
- Amazon States Language is JSON or YAML, awkward to test locally, and unpleasant to review in a diff compared with
  code.
- Debugging is by execution history rather than a debugger, which is a different skill and slower at first.
- More lock-in than plain Lambda. The task functions stay portable; the orchestration does not.
- Standard workflows are billed per state transition. Negligible at a few dozen executions a month — verify the current
  rate and free-tier allowance — but it is a per-step cost, so a chatty state machine is a wasteful one.
- One more service to learn while also learning Terraform, IAM and the rest.

**Mitigations**

- Keep the rule literal: must-answer-now is Lambda, minutes-and-can-fail is a state machine. Nothing in between.
- Keep state machines coarse. Each state should be a meaningful step, not a line of code, which limits both transition
  cost and reviewing pain.
- Put real logic in task Lambdas, which are testable, and keep the state machine to sequencing, waiting, retrying and
  branching.
- Define the state machines in Terraform alongside everything else, so they are reviewable in the same place as the
  resources they act on. See [ADR-0011](0011-terraform-for-infrastructure.md).

## Alternatives considered

| Option | Why not chosen |
| --- | --- |
| Lambda only, with control flow in code | Fewer services and a single language. Either bumps the 15-minute limit or grows a hand-rolled state machine with a status column and self-invocations — which is this ADR's subject, written worse, and with the retry and rollback logic as bespoke code |
| Lambda only, with polling loops for the waits | Simple to write. Bills wall-clock time for doing nothing, and it makes "no fixed compute" a technicality rather than a fact |
| Step Functions for everything, including the API handlers | One mechanism. Adds latency to calls that must answer within a few seconds, which is unacceptable for the Discord acknowledgement in [ADR-0016](0016-chat-integrations.md) |
| Express workflows | Cheaper per execution at volume. Five-minute cap and at-least-once semantics, both wrong for operations that run longer and must never repeat |
| EventBridge chaining Lambdas by event | No new service, and genuinely event-driven. Gives no execution-level view of an operation, no built-in rollback path, and no answer to "which step is it on" |
| A queue with a worker | Conventional and portable. The worker is a process, which contradicts the invariant in [docs/architecture.md](../architecture.md#what-runs-when-nobody-plays) |

## Open questions

- Whether the world switch is its own state machine or a composition of the stop and start machines. Composition is
  tidier if nesting proves comfortable.
- Whether the surfaces read execution state directly or through an API method that flattens it into something stable.
  Flattening is probably right, so the surfaces do not depend on Step Functions' own vocabulary.
- Current per-transition price and free-tier allowance for Standard workflows. Negligible at this scale, but worth
  knowing before designing a chatty machine.
- Whether the health check's wait-and-retry belongs in the state machine's retry configuration or inside a task
  function that owns the judgement about "slow versus hung". See [ADR-0009](0009-s3-as-mod-source-of-truth.md).
