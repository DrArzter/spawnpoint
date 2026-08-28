# ADR-0018 — Cognito as the identity broker, with Google, Discord and Telegram sign-in

- Status: Superseded by [ADR-0037](0037-telegram-only-browser-identity.md)
- Date: 2026-08-11
- Milestone: M4
- Amends: [ADR-0012](0012-web-control-panel.md), which proposed Discord OAuth alone
- Amended by: [ADR-0019](0019-account-linking.md) and [ADR-0021](0021-sign-in-from-linked-chat-account.md) —
  Discord and Telegram are **linked first**, and a linked account may then sign in, but not through Cognito
  federation. The provider table below stands as the analysis; only its Google row is being built

> **Read [ADR-0019](0019-account-linking.md) and [ADR-0021](0021-sign-in-from-linked-chat-account.md) with this
> one.** The two hard parts below — the Discord OIDC shim and the Telegram Login Widget verification — are not
> being built. The open questions at the end of this ADR suspected they would not be worth it, and those two
> ADRs are the answer: a one-time code links a chat account, and a bot-issued one-minute link signs an already
> linked account in. Google is the only federated provider, and the only way a new identity is created.

## Context

Every request to the control-plane API needs an identity: to authorise it, to rate-limit it, and to
attribute it in the "X requested the server" message. See [ADR-0012](0012-web-control-panel.md).

The group is split across platforms. Some live in Discord, some in Telegram, everyone has a Google account.
Asking people to create a password for a Minecraft server is friction nobody will accept, and storing
passwords is a liability worth avoiding entirely.

Three important facts, verified in August 2026 and worth re-checking before implementation, because they
decide most of the design:

1. **Google is a native Cognito social provider.** Configuration only.
2. **Discord is OAuth 2.0, not OpenID Connect.** It issues no `id_token` and publishes no discovery document,
   and Cognito federation requires OIDC. Discord therefore cannot be added directly. The known workaround is
   a self-hosted shim that wraps Discord's API in an OIDC layer, exposing authorization, token, userinfo and
   JWKS endpoints; `discord-cognito-openid-wrapper` is an existing example of the pattern.
3. **Telegram is neither.** The Login Widget returns a JSON payload — `id`, `first_name`, `username`,
   `photo_url`, `auth_date`, `hash` — authenticated by an HMAC-SHA256 of the sorted fields, keyed by the
   SHA-256 of the bot token. It must be verified server-side, including a freshness check on `auth_date` to
   prevent replay. There is no OAuth flow to federate.

A fourth fact reframes the problem. The **bots do not need any of this.** Discord signs its interaction
requests, and Telegram webhook requests carry a secret token; both payloads already identify the user. Chat
commands are authenticated by the platform itself. See [ADR-0016](0016-chat-integrations.md). OAuth is needed
only for the *web panel*.

## Decision

A Cognito user pool is the identity broker for the web panel. The API accepts a Cognito-issued JWT, and
nothing else.

Providers, in the order they are worth building:

| Provider | Mechanism | Effort |
| --- | --- | --- |
| Google | Native Cognito social IdP | Configuration |
| Discord | Self-hosted OIDC shim in front of Discord's OAuth 2.0, added to Cognito as an OIDC provider | One small service to write, host and secure |
| Telegram | Login Widget, verified by a Lambda that checks the HMAC and `auth_date`, then signs the user in through a Cognito custom authentication flow | Custom, and the most work of the three |

**One person is one internal identity.** A player may sign in with Google on the panel and issue commands from
Telegram, and both must resolve to the same person and the same role. Identities are linked **explicitly**:
sign in once, then link the chat accounts from an account page. Linking is never inferred from an email
address — Telegram supplies none, and matching on email is a well-known account-takeover route. The linking
mechanism is [ADR-0019](0019-account-linking.md).

Roles stay as [ADR-0012](0012-web-control-panel.md) set them: player, and owner.

## Consequences

**Good**

- No passwords stored, and no credential handling in this project at all.
- People sign in with an account they already have, which is the difference between a panel that gets used and
  one that does not.
- One token format at the API, whatever the provider, so authorisation logic stays in one place.
- Chat commands need none of it, so the useful half of the system works before any of this is built.
- Cognito's monthly-active-user allowance is generous relative to a handful of players. Verify the current
  pricing tier and allowance before relying on it.

**Bad, or risky**

- **Discord costs a service.** The OIDC shim is a component to write, host, patch and secure, and it sits in
  the authentication path — the worst place for a home-made component to fail.
- **Telegram costs custom code** in the authentication path, including HMAC verification and replay
  protection. Getting either wrong is an authentication bypass, not a bug.
- The bot token becomes an authentication secret as well as a bot credential, so its compromise is worse than
  it first appears.
- Account linking is genuinely fiddly, and the naive implementations are the insecure ones.
- Three providers is three sets of console configuration, redirect URIs and callback URLs to keep correct.

**Mitigations**

- **Build it in phases, and stop when the value runs out.** Google-only first. Discord and Telegram sign-in
  only if somebody actually wants to use the panel with those identities — which may never happen, because
  those people are already using the bots.
- Treat the Discord shim as security-relevant code: pin its dependencies, keep it minimal, and prefer reading
  the existing wrapper's approach over inventing one. Check its licence before reusing any of it.
- For Telegram, verify the HMAC, reject an `auth_date` older than a short window, and store the Telegram user
  ID as the identifier — never the username, which can be changed and reused.
- Keep the allow-list as the real gate. Authentication proves who somebody is; the allow-list decides whether
  they may spend money. A stranger with a valid Google account must reach nothing.
- Write down which provider is authoritative for a person, so a linked identity cannot be used to escalate a
  role.

## Alternatives considered

| Option | Why not chosen |
| --- | --- |
| Discord OAuth directly, no Cognito, as ADR-0012 proposed | Fewest components, and Discord membership is a natural allow-list. Rejected because it excludes the Telegram-only members and makes Discord a hard dependency for every surface |
| Google only, forever | Almost free to build, and everyone has an account. Genuinely sufficient, and it is deliberately phase one. Kept as the fallback if the other two prove not worth it |
| A shared access code, no accounts | Trivial, and adequate to start the server. No attribution, so no per-person rate limit and no "who started it" message. Rejected by [ADR-0006](0006-on-demand-start-and-idle-shutdown.md) |
| Own OAuth implementation for all three | More learning, and an authentication bug is an unbounded failure in a system that spends money. Not the place to practise |
| A third-party auth service (Auth0, Clerk, Firebase Auth) | Supports more providers with less work, and would probably handle Telegram more cleanly. Rejected because it adds a vendor and, in this project, Cognito is the thing worth learning |
| Cognito identity pool with developer-authenticated identities | A legitimate route for Telegram in particular. Compared against the custom authentication flow in the open questions below; the decision needs prototyping, not reasoning |

## Open questions

Answered by [ADR-0019](0019-account-linking.md):

- ~~Whether Telegram sign-in is worth building at all, once the Telegram *bot* already works.~~ No.
- ~~Whether the Discord shim is worth hosting, for the same reason.~~ No. Google-only is the whole answer.
- ~~For Telegram, custom authentication flow versus developer-authenticated identities.~~ Neither is needed.
- ~~Where the account-link record lives, and how a link is revoked.~~ A link table, keyed by platform and
  platform user ID; unlink deletes the record.

Still open:

- Current Cognito pricing tier, its monthly-active-user allowance, and which features this needs.
- Whether anybody in the group refuses to use a Google account **and** will not link a chat account either. If
  so, email sign-in is the fallback, and it is the main trigger for adding SES. See
  [ADR-0020](0020-email-channel.md). Note that Google is still the only route by which an identity is *created*,
  so this matters for first contact rather than for daily use. See
  [ADR-0021](0021-sign-in-from-linked-chat-account.md).

## Sources

Verified 2026-08-11. Re-check before implementing.

- Cognito OIDC and social identity providers: <https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-identity-provider.html>
- Discord OIDC shim, as an example of the pattern: <https://github.com/qwerqy/discord-cognito-openid-wrapper>
- Telegram Login Widget, and the hash verification procedure: <https://core.telegram.org/widgets/login>
