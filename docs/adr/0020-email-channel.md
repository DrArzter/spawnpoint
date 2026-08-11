# ADR-0020 — SNS email subscriptions for alerts; no SES until something needs it

- Status: Accepted
- Date: 2026-08-11
- Milestone: M5

## Context

Three separate questions hide behind "should we add email":

1. **Out-of-band alerting.** When the chat adapters are broken, or the whole account is misconfigured, alerts
   must still arrive somewhere. [ADR-0015](0015-observability-and-alerting.md) already requires this for the
   Budgets alarm, because a cost alarm that depends on the application working is not a backstop.
2. **Notifying players.** Server ready, new pack released, session ended.
3. **Email as an identity.** A sign-in route for somebody who will not use a Google account —
   [ADR-0018](0018-identity-and-sign-in.md) chose Google-only, which excludes them.

Only the third one genuinely needs Amazon SES. SNS sends email to a subscribed address directly, with no SES
setup, no domain verification and no sending reputation to manage. And players are already in chat, where
[ADR-0016](0016-chat-integrations.md) reaches them faster than email would.

SES also has real setup friction worth stating before choosing it. A new SES account starts in a sandbox: it
can send only to verified addresses, with a low daily cap, until production access is requested and granted.
A domain needs DKIM, SPF and DMARC records — cheap, since [ADR-0017](0017-stable-server-address.md) already
puts a hosted zone in Route 53 — and a brand-new sending domain has no reputation, so early mail may be
filtered. Verify the current sandbox limits, the free-tier allowance and the per-message rate before relying on
any of it; outbound SES is inexpensive at this volume, but "inexpensive" is not the obstacle here.

## Decision

**Now:** email is an alert channel only, delivered by an SNS email subscription on the same topic the chat
adapters subscribe to. The Budgets alarm and the backup-failure alarm go to it. No SES.

**Not now:** SES. It is deferred, not rejected on principle. It becomes worth adding when one of these is true:

- Somebody actually wants to sign in to the panel without a Google account, and email sign-in is the answer.
  This is the most likely trigger. See [ADR-0018](0018-identity-and-sign-in.md).
- Mail needs to come from the project's own domain rather than an SNS-formatted notification — for example if
  the panel ever sends anything a recipient is meant to reply to or trust.
- Volume or formatting outgrows what an SNS subscription can express. SNS email is plain and includes topic
  metadata; it is adequate for an alert and poor for anything a person is meant to enjoy reading.
- **Learning is the reason.** Configuring DKIM, SPF and DMARC, and getting out of the SES sandbox, is a real
  skill and this project exists partly to acquire real skills. That is a legitimate trigger here in a way it
  would not be at work — see [ADR-0003](0003-build-not-reuse.md) — provided it is done as a self-contained
  addition and not wired into the critical path.

Until then, no mail server, no mail receiving, and no mailbox to maintain.

## Consequences

**Good**

- The out-of-band alert path exists from M5 with essentially no work: one subscription, one confirmation click.
- No domain verification, no sandbox request, no sending reputation to protect, and no deliverability problem
  to debug during an incident.
- Nothing extra to secure. An unused SES identity is a way to send mail as your domain, and not having one is
  one fewer credential to worry about.
- The decision is reversible, and the trigger list says exactly when to revisit it.

**Bad, or risky**

- SNS email looks like a machine sent it, because one did. Fine for an alarm, wrong for anything player-facing.
- The subscription is per-address and confirmed by the recipient, so adding people is manual. Acceptable: the
  only subscriber is the owner.
- Google-only sign-in still excludes anybody who refuses a Google account, and this ADR does not fix that. It
  names it as the trigger that would.

**Mitigations**

- Keep the email subscription for alarms only, so nobody starts treating it as a notification channel.
- Revisit at the end of M5, when the real alert volume is known, rather than assuming this holds forever.

## Alternatives considered

| Option | Why not chosen |
| --- | --- |
| SES for all notifications | A proper sender and better formatting, but it duplicates the chat channels, where the group actually reads things, and adds sandbox and deliverability work for no gain |
| SES only for alerts | Same alerting outcome as an SNS subscription, with domain verification and a sandbox request on top |
| Chat only, no email at all | Simplest, and tempting. Rejected because the backstop alarm must not depend on the thing it is watching. A cost alarm that only reaches a broken system is decoration |
| A self-hosted mail server | Never, for this. Deliverability from a small IP address is a full-time hobby of its own, and it needs an always-on host, which the whole design avoids |
| A third-party sender (Postmark, Resend, Mailgun) | Better deliverability and much nicer developer experience than SES. Rejected while there is no sending use case at all; reconsider alongside SES if a trigger fires |
| SES inbound, to receive mail | No use case. The system has nothing to read email for |

## Open questions

- Which address the alarms go to, and whether a second person should also be subscribed so alerts survive one
  person's holiday.
- Whether email sign-in, if it ever happens, uses Cognito's own sending — which has a low cap and is intended
  for development — or SES from the start. Cognito's built-in sender is the thing to check first.
