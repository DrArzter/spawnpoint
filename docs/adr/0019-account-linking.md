# ADR-0019 — Link chat accounts with a one-time code, rather than federating them as sign-in providers

- Status: Superseded by [ADR-0057](0057-link-login-providers-through-the-current-identity.md)
- Date: 2026-08-11
- Milestone: M4
- Amends: [ADR-0018](0018-identity-and-sign-in.md), which planned Discord and Telegram as Cognito providers
- Amended by: [ADR-0021](0021-sign-in-from-linked-chat-account.md) — a linked chat account may also **sign in**,
  which this ADR did not allow. The link remains the prerequisite, so everything below still holds

## Context

[ADR-0018](0018-identity-and-sign-in.md) planned to add Discord and Telegram as sign-in providers to the
Cognito user pool. Both are expensive to do that way: Discord is OAuth 2.0 rather than OIDC, so Cognito needs
a self-hosted OIDC shim in front of it, and Telegram is neither, so it needs custom HMAC verification in a
Cognito custom authentication flow. Both pieces of code would sit in the authentication path, where a bug is
an account takeover rather than a broken feature.

The panel does not actually need those identities to *authenticate* anybody. It needs to know that the person
signed in to the panel is the same person as a given Discord or Telegram user. That is a different and much
smaller problem: **linking**, not authentication.

Linking is also the thing the system needs for its own reasons, independent of sign-in:

- One person across surfaces, so "X requested the server" reads the same whether the request came from the
  panel, Discord or Telegram.
- Rate limits per person. Without linking, one person gets a separate budget on each surface.
- One role per person. The owner role is granted once and works everywhere.
- Personal replies. "Your restore finished" belongs in a direct message, not the group channel.
- Revoking one surface without removing the person.

The chat platforms already authenticate their users, and their requests are already verified: Discord signs
its interaction requests, Telegram's webhook carries a secret token. A bot command therefore arrives with a
trustworthy platform user ID for free. That is the asset to build on.

## Decision

The panel has an **account page** with "Connect Telegram" and "Connect Discord". Linking is done with a
one-time code, in the direction chat-proves-itself-to-web:

1. The signed-in user asks the panel to connect a platform. The panel returns a short code — six characters,
   single use, valid for a few minutes, bound to that user.
2. The user sends `/link ABC123` to the bot.
3. The bot's request arrives already verified by the platform, so the handler has a trustworthy platform user
   ID. It exchanges the code for the internal identity and writes the link.
4. Both surfaces confirm. The link is recorded in the audit trail, and a notice goes to the other channel.

No OAuth flow, no OIDC shim, and no verification code in the authentication path.

**Panel sign-in stays Google-only.** The Discord OIDC shim and the Telegram custom authentication flow from
[ADR-0018](0018-identity-and-sign-in.md) are not built. That ADR suspected they would not be needed; this is
the answer.

> **Amended by [ADR-0021](0021-sign-in-from-linked-chat-account.md).** A linked chat account may now also be
> used to sign in — but only once linked, and the link is still created exactly as described here. Google or an
> owner invite remains the only way an identity comes into existence.

**The link table is the allow-list.** A linked platform account is an authorised one; an unlinked one is
refused with an instruction on how to link. Two ways in:

- Self-serve: sign in to the panel with Google, generate a code, send it to the bot.
- Owner-issued invite: the owner generates a code for somebody who will never open the site. Redeeming it in
  chat creates the internal identity and the link together.

Storage: a table keyed by `(platform, platform_user_id)` → internal identity, with a reverse index for the
account page. Store the numeric platform ID and a display name for the UI, and nothing else.

## Rules

These are the parts that are easy to get wrong, so they are decisions, not implementation detail.

- **Linking grants no privilege.** It attaches a surface to an existing identity and never changes a role.
  Otherwise linking is a privilege escalation path. This holds even though a link is now also a sign-in route:
  signing in through it grants exactly the role the identity already had. See
  [ADR-0021](0021-sign-in-from-linked-chat-account.md).
- **One chat account links to at most one internal identity.** Re-linking requires unlinking first. This
  prevents two people claiming one chat account, and prevents somebody attaching their own chat account to
  another person's identity to receive their notifications.
- **Codes are single use, short-lived, rate-limited per user, and bound to the issuing identity.** A code that
  has expired or been used is refused without explanation of which.
- **Unlink works from both sides**, and unlinking deletes the record rather than flagging it. Because the link is
  the sign-in route, deleting it revokes that route immediately.
- **Store the platform user ID, never the username.** Usernames change and can be reused by somebody else.
- **Every link and unlink is announced to the person on the other channel** and written to the audit trail.
  This is standard account-security practice, and it is how a mistaken or hostile link is noticed.

## Consequences

**Good**

- Removes the two hardest pieces of [ADR-0018](0018-identity-and-sign-in.md): no OIDC shim to host and patch,
  no custom code in the authentication path.
- The remaining verification code is out of the authentication path. Its worst failure is a wrongly claimed
  chat account — bad, bounded, detectable and reversible — not an account takeover.
- Uses the authentication the chat platforms already perform, instead of re-implementing it.
- One identity per person across all surfaces, which is what attribution, rate limiting and roles all need.
- The link table doubles as the allow-list, so there is no second list to maintain and drift.
- Cheap to build. A code table, two bot commands and a panel page.

**Bad, or risky**

- A three-step flow is more friction than pressing "Sign in with Discord". People will need telling once.
- Every player needs one Google sign-in to self-serve, which is a hurdle for anybody who will not open the
  site. The owner-issued invite exists for them, and it is more work for the owner.
- A code is a bearer token for a few minutes. Leaked in a public channel, somebody else could redeem it.
- Two more pieces of state — codes and links — with their own expiry and cleanup.
- Somebody who loses access to their Google account loses the panel identity that the links hang from.

**Mitigations**

- Show the code in the panel only, never send it through chat, and say plainly that it must be sent to the bot
  in a direct message.
- Codes expire in minutes, are single use, and are rate-limited per identity. A redeemed code is reported to
  the issuer, so a stolen redemption is visible.
- Because linking grants no privilege, a wrongly redeemed code attaches a surface to an identity — annoying,
  reversible by unlinking, and not an escalation.
- The owner can unlink anything, and the audit trail shows who linked what and when.
- Keep the personal data minimal: platform ID and display name only. Unlink deletes it. Nothing else about a
  chat account is stored.

## Alternatives considered

| Option | Why not chosen |
| --- | --- |
| Discord and Telegram as Cognito sign-in providers, per ADR-0018 | One button instead of three steps, and no code to copy. Costs a self-hosted OIDC shim and custom authentication code, both in the authentication path, for a group of five |
| Plain Discord OAuth 2.0 for linking only, not for sign-in | Genuinely reasonable: Discord's non-OIDC OAuth is fine when we are the consumer, since `/users/@me` with the access token is enough, and no shim is needed. Rejected for consistency — one linking mechanism for both platforms is less code and one thing to reason about. Reconsider if the code flow annoys people |
| Telegram Login Widget on the account page for linking | Also workable, and no code to copy. Keeps the HMAC verification code, and needs a second, different flow beside Discord's |
| No linking; each surface has its own allow-list | Simplest today. Three lists that drift, no per-person rate limit, and "X requested the server" cannot name one person consistently |
| Match accounts by email address | Zero friction. Telegram supplies no email at all, and matching on email is a well-known account-takeover route. Rejected outright |
| Owner links accounts by hand | Fine at five players, and a reasonable stopgap before the code flow exists. Does not scale past the owner's patience, and the owner has to be told each platform ID |

## Open questions

- Whether an unlinked but known platform account should get a helpful refusal naming the link flow, or a flat
  refusal. Helpful, unless it turns out to leak who is registered.
- Whether the owner-issued invite is needed at all, or whether everybody will sign in to the panel once anyway.
- Code length and lifetime. Six characters and five minutes is the starting assumption, with rate limiting
  doing the real work.
- Whether a person may link two accounts on the same platform — a phone and a desktop Telegram account are the
  same account, so probably not, but a second Discord account is conceivable. Default: no.
