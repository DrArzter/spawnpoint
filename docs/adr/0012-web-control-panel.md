# ADR-0012 — One control-plane API, with the web panel as one of several clients

- Status: Proposed
- Date: 2026-08-11
- Milestone: M4
- Amended by: [ADR-0018](0018-identity-and-sign-in.md) — the authentication paragraph below is superseded
- Amended by: [ADR-0029](0029-preview-environments.md) — **the panel no longer reviews or approves releases.** That
  moved into a pull request, which was the job that justified building a panel at all. The API and the several-clients
  shape below are untouched; what shrank is the panel's share of them. See [web/README.md](../../web/README.md)

## Context

Several surfaces need to do the same small set of things: start the server, read its status, list and
promote releases, list and restore backups, read recent logs. The planned surfaces are a web panel, a
Discord bot, a Telegram bot, and a local CLI for the owner. See [ADR-0016](0016-chat-integrations.md).

Implemented per surface, each one grows its own copy of the rules — who may start the server, what happens
when a promotion fails, how a rate limit applies — and they drift. The bot ends up able to do something the
panel forbids.

A second problem: the interesting operations are slow. Starting the server takes minutes; a release
promotion takes longer. A request-response call cannot express that, and every surface needs to show
progress.

## Decision

One control-plane API is the only way to change anything. Every surface is a thin client of it, with no
business rules of its own. API Gateway in front of Lambda handlers, one handler per operation.

Slow operations are modelled as **operations with state**, not as long requests. A start request creates an
operation, returns its identifier immediately, and the operation moves through queued → starting →
running → ready, or → failed. Clients poll it, or receive its terminal event.

Every request carries an identity, and every operation records who requested it, which is what
[ADR-0006](0006-on-demand-start-and-idle-shutdown.md) needs for attribution.

> **Amended.** This ADR originally chose Discord OAuth as the identity provider. That excludes the
> Telegram-only members of the group, so identity moved to a Cognito user pool federating several providers.
> See [ADR-0018](0018-identity-and-sign-in.md). Everything else here stands.

The web panel is a static single-page site on S3 and CloudFront, alongside the modpack downloads. See
[ADR-0013](0013-modpack-distribution.md).

## Consequences

**Good**

- One place holds the rules, so the panel and the bots cannot disagree about what is allowed.
- Adding a surface is a client, not a feature. The Telegram bot becomes small.
- Operation state makes progress reporting uniform, and makes a stuck start visible instead of silent.
- Identity on every request gives attribution, rate limiting and an audit trail from one mechanism.
- No server to run for the panel or the API when nobody is using them.

**Bad, or risky**

- More structure than a hobby project strictly needs. A single Lambda with a shared secret would work
  sooner.
- Operation state needs somewhere to live. Resolved by [ADR-0025](0025-step-functions-for-long-operations.md) at no
  extra cost in stores.
- Discord OAuth is a dependency for logging in. If Discord is down, so is the panel.
- A public API that spends money is a public API that needs its authorisation to be right the first time.

**Mitigations**

- Keep the operation set small and boring: start, status, releases, promote, backups, restore, logs.
- Two roles only — player, who may start and read, and owner, who may promote and restore. Anything more
  is premature.
- A CLI path for the owner that uses AWS credentials directly, so the panel and Discord are never the only
  way in.
- Rate-limit per identity, and cap concurrent operations at one. Two simultaneous starts must not create
  two instances.

## Alternatives considered

| Option | Why not chosen |
| --- | --- |
| Logic in each surface, no shared API | Fewer components at first, but the rules diverge, and the panel and bots become subtly different products |
| One Lambda with a shared secret and no identity | Quickest to build, and adequate for starting the server. Gives no attribution, so no per-user rate limit and no "who started it" message |
| Cognito user pool | Judged heavier than a group of friends needs when this ADR was written. Reconsidered and chosen in [ADR-0018](0018-identity-and-sign-in.md), because it is the only option that covers Google, Discord and Telegram members with one token format |
| A small always-on backend (Fargate or a VPS) with WebSockets | Nicer live progress, but a fixed monthly cost and a component to keep alive — for a panel used a few times a week |
| No panel; chat bots only | Genuinely sufficient for start and status, and cheaper to build. Rejected because release history, backups and the pack download read badly in a chat window |

## Open questions

- ~~Where operation state lives.~~ Answered by [ADR-0025](0025-step-functions-for-long-operations.md): a Step Functions
  execution runs the operation and *is* its state, so no table is needed for it.
- Whether the panel shows live logs, and if so how they are streamed without an always-on component.
- Whether a player who is not in the Discord server can be given a limited download-only view.
