# ADR-0036 — Observe visitors, but let an Owner grant access

- Status: Proposed
- Date: 2026-08-28
- Milestone: M4
- Amends: [ADR-0018](0018-identity-and-sign-in.md), [ADR-0019](0019-account-linking.md), and [ADR-0021](0021-sign-in-from-linked-chat-account.md)

A verified Telegram webhook tells Spawnpoint which Telegram account sent `/start`, but it does not make that person trusted. Spawnpoint records such an account as an **access candidate** and gives the **visitor** only a deliberately public surface: coarse server state, supported games, and a way to request access. It does not reveal addresses, overlay-network identifiers, player activity, releases, backups, logs, errors, or operations that can spend money.

An Owner or another identity with `access.manage` reviews candidates in the control panel and either dismisses one or creates an Identity with a selected role. This is the owner-issued-invite path from ADR-0019 with less copy-and-paste: the platform account is already proven by the signed platform interaction, so approval can atomically create the Identity and link the observed Telegram account. Merely writing to the bot never grants a role.

The SSM allow-list remains only as a migration fallback while the common authorization API is introduced. It must not remain a second source of truth: after cutover, bots and the panel resolve the same Identity and permissions from the access store.

Telegram is the browser authentication provider, as decided by [ADR-0037](0037-telegram-only-browser-identity.md). A successful signed Widget or Mini App login observes a Visitor, but authorization still comes from the Spawnpoint Identity and its grants; possessing an arbitrary Telegram account grants no operational access.

## Consequences

- Onboarding no longer requires asking a stranger to find and copy a numeric Telegram ID.
- The owner gets an auditable queue instead of editing Parameter Store.
- Public status must stay a separate response shape so a later field cannot accidentally expose an address or release to visitors.
- Candidate records are personal data and therefore store only the stable platform ID, current display fields, timestamps, and review state.
