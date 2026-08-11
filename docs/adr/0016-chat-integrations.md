# ADR-0016 — Discord and Telegram are control surfaces and the notification channel

- Status: Proposed
- Date: 2026-08-11
- Milestone: M4

## Context

The group already talks in Discord, and some members prefer Telegram. That is where "start the server" gets
asked and where "is it up yet?" gets asked again ten minutes later. A web panel answers both, but only for
somebody who remembers the URL and opens a browser. A chat command is answered in the place the question was
already being asked.

The same channels are the right place for the system to talk back. Every event this system produces — a start
requested, a server ready, a release promoted, a rollback, a failed backup — is something the group wants to
read, and something [ADR-0015](0015-observability-and-alerting.md) needs a delivery route for.

Both platforms impose shapes on the solution. Discord interactions must be acknowledged within a few seconds
and their requests must be signature-verified, so a slow operation cannot be answered inline. Telegram offers
either long polling, which needs a process that is always running, or a webhook, which does not.

## Decision

**Commands.** Both bots are thin clients of the control-plane API, with no rules of their own. See
[ADR-0012](0012-web-control-panel.md). Discord uses registered slash commands delivered to an interactions
endpoint; Telegram uses a webhook with a secret token. Each platform gets one Lambda that verifies the
request, maps the platform user to an internal identity, calls the API, and acknowledges immediately with a
"working on it" reply that is edited as the operation progresses.

Command set, deliberately small:

| Command | Effect |
| --- | --- |
| `start` | Requests a server start, attributed to the caller |
| `status` | Server state, player count, live release version |
| `pack` | Link to the current client pack and its version |
| `release list` / `release promote <version>` | Owner only |
| `backup list` / `backup restore <id>` | Owner only, and confirmed twice |
| `link <code>` | Links this chat account to a panel identity. See [ADR-0019](0019-account-linking.md) |
| `panel` | Returns a one-minute sign-in link for the linked identity. Direct message only. See [ADR-0021](0021-sign-in-from-linked-chat-account.md) |

**Notifications.** Every component publishes events to one SNS topic. One small adapter Lambda per channel
subscribes and formats for its platform. Nothing that produces an event knows which channels exist.

Events published: start requested, with the requester; server ready, with the address and cold-start duration;
server stopped, with the session length; Spot interruption; release promoted; release rolled back; backup
completed or failed; alarm fired.

## Consequences

**Good**

- The server can be started from where the conversation is already happening, which is the only interface
  people reliably use.
- "User X requested the server, starting now" followed by "server is ready" removes the entire class of
  waiting-and-asking messages.
- Adding or removing a channel is one adapter. The pipeline and the lifecycle code do not change.
- The bots need no hosting. Both are event-driven Lambdas with no idle cost.
- One event stream serves both the group's notifications and the operational alerts, so alerting has a real
  delivery route from day one.

**Bad, or risky**

- Two more integrations to keep working, each with its own API, signature scheme and breaking changes.
- Bot tokens are credentials that can post as the bot in the group's channels.
- Chat is a lossy interface for anything with structure: a release list or a backup list reads badly.
- Command spam. `start` is cheap to type and starts a billed instance.
- A Discord interaction that is not acknowledged in time shows the user a failure even though the work
  succeeded.

**Mitigations**

- Verify every request: Ed25519 signature for Discord, secret token for Telegram. Reject anything unverified,
  and never trust the user identity in the payload without it.
- Bot tokens in SSM Parameter Store as encrypted parameters, never in Terraform state or the repository. See
  [ADR-0011](0011-terraform-for-infrastructure.md). A bot is also a sign-in issuer, which raises the value of
  that secret — rotating it is a runbook step. See [ADR-0021](0021-sign-in-from-linked-chat-account.md).
- Acknowledge first, work second. Every command replies immediately and edits the reply as the operation
  advances.
- Allow-list by platform user identity, mapped to the two roles from ADR-0012 through the link table in
  [ADR-0019](0019-account-linking.md). Rate-limit per person rather than per surface, and make `start`
  idempotent so a second call joins the running operation rather than creating another.
- Anything with structure — release history, backup list, pack details — links to the panel rather than trying
  to render in chat.

## Alternatives considered

| Option | Why not chosen |
| --- | --- |
| Web panel only | One surface to build and secure, but it is not where the group already is, so the "start it for me" messages continue |
| Discord only | Covers most of the group and halves the work. Telegram is genuinely used by some members, and the adapter pattern makes the second channel cheap |
| A single always-on bot process on the game instance | Simplest bot code, but it can only answer while the server is already running — precisely useless for a start command |
| An always-on bot on a small separate host | Works, and long polling becomes available, but reintroduces a fixed monthly cost and a component that must stay alive |
| Webhooks for notifications, no commands | Half the value for a fraction of the work, and a reasonable first step. Kept as the M4 stepping stone: notifications first, commands second |
| Email or SMS notifications | Nobody reads either for this, and SMS costs per message |

## Open questions

- ~~How a platform user identity is linked to the panel identity.~~ Answered by
  [ADR-0019](0019-account-linking.md): a one-time code, generated in the panel and sent to the bot. The link
  table doubles as the allow-list, so `start` from an unlinked account is refused.
- Whether a message announcing a start should be posted before the operation is authorised, or after. After,
  to avoid a channel full of rejected attempts.
- Whether the bots should report cost, for example a monthly figure on request. Attractive, and it needs the
  Cost Explorer API, which has its own per-request charge.
