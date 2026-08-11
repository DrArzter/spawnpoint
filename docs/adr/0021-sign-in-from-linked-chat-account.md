# ADR-0021 — Discord and Telegram can sign in, but only into an account they are already linked to

- Status: Proposed
- Date: 2026-08-11
- Milestone: M4
- Amends: [ADR-0018](0018-identity-and-sign-in.md) and [ADR-0019](0019-account-linking.md)

## Context

[ADR-0019](0019-account-linking.md) made chat accounts *linkable* but not usable for signing in. That leaves a
gap: somebody who lives in Telegram, has linked it, and now wants to open the panel still has to remember
which Google account they used.

The requirement is narrower than open federation, and the narrowness is the point:

> Discord and Telegram work as sign-in providers, **but only if the account has already been linked to an
> existing identity.**

This is the "no just-in-time provisioning" rule. A chat provider can never *create* an identity — it can only
authenticate into one that already exists and has already been bound to it. The identity set stays closed:
every account originates from a Google sign-in or an owner-issued invite, both of which are deliberate acts.

Worth being honest about what the rule does and does not buy. It removes account creation by a stranger with a
Discord account, which is real. It does **not** by itself remove the technical cost that
[ADR-0018](0018-identity-and-sign-in.md) identified: if those platforms authenticate anybody at all, something
must verify them, and that something is in the authentication path. A bypass in it means impersonating a
linked chat account, which is a takeover of an existing account — the worse outcome, not the milder one. So the
mechanism still has to be as small and as auditable as possible.

There is a cheaper mechanism that satisfies the rule exactly. The bots are already authenticated: Discord signs
its interaction requests and Telegram's webhook carries a secret token, so a bot handler already knows, with
certainty, which platform user is talking to it. The link table already maps that user to an internal identity.
Everything needed to sign somebody in is therefore already present on the bot side — no OAuth flow, no OIDC
shim, and no third-party signature scheme to re-implement.

## Decision

**The rule.** A chat provider may only authenticate into an identity it is already linked to. An attempt from
an unlinked account is refused with an instruction to link first. Nothing about a chat sign-in ever creates an
identity, and nothing about it ever changes a role.

**The mechanism.** Sign-in is issued by the bot, in the opposite direction to linking:

1. The user sends `/panel` to either bot, in a direct message.
2. The handler verifies the platform signature, looks the platform user ID up in the link table, and refuses if
   there is no link.
3. It mints a single-use token, valid for about a minute, bound to that identity, and replies with a URL
   containing it — in the direct message only, never in a channel.
4. Opening the URL exchanges the token for a session, through a Cognito user pool custom authentication flow
   whose verifier checks one thing: is this token present, unused, unexpired and bound to this user.

The exchange uses the three custom-authentication Lambda triggers, verified against the documentation:

| Trigger | Its job here |
| --- | --- |
| Define auth challenge | The state machine. Reads the session array of attempts so far and answers: issue a custom challenge, `issueTokens`, or `failAuthentication` |
| Create auth challenge | Emits the challenge. Nothing meaningful in our case — the answer is already in the user's URL |
| Verify auth challenge response | The only real check: token present, unused, unexpired, bound to this user |

No password is involved. Starting `InitiateAuth` with `AuthFlow: CUSTOM_AUTH` and `CHALLENGE_NAME: CUSTOM_CHALLENGE`
skips password verification entirely, which is exactly what a link-based sign-in needs. On success Cognito
returns an ID token, an access token **and a refresh token**, so the session persists and the one-minute link is
needed rarely rather than every visit.

Linking and signing in are therefore the same primitive in opposite directions:

| Flow | Direction | What proves what |
| --- | --- | --- |
| Link | Panel issues a code → redeemed in the bot | The chat platform proves the platform user; the code proves it is the same person as the web session |
| Sign in | Bot issues a link → opened in the browser | The chat platform proves the platform user; the link table proves which identity; the token carries it to the browser |

**Not built:** the Discord OIDC shim and the Telegram Login Widget verification from
[ADR-0018](0018-identity-and-sign-in.md). Google remains the only Cognito federated provider.

## Invariants

- No just-in-time provisioning. A chat sign-in into an unlinked account fails; it never creates one.
- Sign-in grants exactly the role the identity already has. Same rule as linking in [ADR-0019](0019-account-linking.md).
- Tokens are single use, short-lived, bound to one identity, and rate-limited per identity.
- Tokens are delivered only in a direct message. A bot must refuse `/panel` in a shared channel, because the
  reply would be a session for whoever clicks first.
- Revoking a link revokes this sign-in route immediately, because the route is the link.
- Each issued and each redeemed token is written to the audit trail, and a redemption is reported to the user.

## Consequences

**Good**

- Does what the requirement asks, with no OIDC shim to host and no third-party signature scheme to
  re-implement. The only thing verified in the authentication path is a token this system issued itself.
- The identity set stays closed. No stranger with a Discord account can create anything.
- One mechanism covers both platforms, and it is the one already built for linking, in reverse.
- Revocation is trivially correct: unlink and the route is gone. There is no separate provider connection left
  behind in Cognito.
- A Telegram-only member never needs to remember a Google account after their first sign-in.

**Bad, or risky**

- A one-minute URL is a bearer token. Pasted into a channel by mistake, it is a session for a stranger until it
  expires or is used.
- A Cognito custom authentication flow is still required, which is real code in the authentication path — a
  much smaller surface than an HMAC scheme, but not zero.
- **Custom authentication cannot run inside Cognito managed login.** The documentation is explicit: custom
  authentication needs application logic in the client, so the hosted sign-in pages cannot process it. The panel
  must therefore drive the user pools API itself for this route — `InitiateAuth`, then `RespondToAuthChallenge` —
  even if Google sign-in uses managed login. Two code paths in the panel, not one.
- Two token types now exist, link codes and sign-in tokens, with separate expiry and cleanup. Confusing them in
  code would be serious, since one grants a session.
- A compromised bot token lets an attacker impersonate the bot, and the bot is now a sign-in issuer. That
  raises the value of that secret.
- If somebody loses their Google account, the chat route still works — convenient, and it also means losing
  control of a chat account is enough to reach the panel.

**Mitigations**

- Refuse `/panel` outside a direct message, and say why. Never post a token where more than one person can read
  it.
- Single use, about a minute, and report the redemption to the user so an unexpected one is visible.
- Keep the two token types in separate tables with different shapes, so one can never be redeemed at the other
  endpoint.
- Bot tokens stay in SSM Parameter Store as encrypted parameters, and rotating one is a documented runbook step.
- The owner can unlink any account, which immediately closes that route.
- Because sign-in grants no more than the identity already has, the worst case is access to a player role, not
  to the owner role. The owner should keep Google as their primary route.

## Alternatives considered

| Option | Why not chosen |
| --- | --- |
| Real Cognito federation with a link precondition — Discord through an OIDC shim, Telegram through a custom flow, plus a pre-sign-up or pre-token Lambda that refuses when no link exists | This is the literal reading of the requirement, and it gives a one-click "Sign in with Discord" button. It costs a self-hosted shim in the authentication path, a correct implementation of Telegram's HMAC scheme, and per-provider configuration — all to reach the same place as a bot-issued link. Documented here so it can be chosen deliberately if the button is wanted for its own sake |
| Linking only, no chat sign-in at all, as ADR-0019 left it | Least code. Leaves the Telegram-only member depending on a Google account they may not want to use |
| Open federation, any Discord or Telegram account creates an identity | One click, no prerequisite. Rejected by the requirement, and correctly: it makes account creation available to anybody who finds the URL |
| Email magic link instead | Same primitive, one channel for everybody, and it removes the chat dependency. Needs a sender, which [ADR-0020](0020-email-channel.md) deliberately deferred. Reconsider together with SES |
| A long-lived session cookie after the first sign-in, so re-authentication is rare | Reduces how often any of this matters, and is worth doing anyway. The refresh token from the custom auth flow gives this for free. Not an alternative to having a route |
| Identity pool with developer-authenticated identities | Checked against the documentation, and it is the wrong shape rather than the harder one. It produces **temporary AWS credentials**, not user pool tokens: the backend calls `GetOpenIdTokenForDeveloperIdentity` with admin credentials, and the client exchanges the result for IAM credentials. Our panel talks to API Gateway, not to AWS services directly, so this would mean two different authorisation mechanisms on one API — a JWT for Google sign-ins and IAM for chat sign-ins — against the single-token-format goal in [ADR-0012](0012-web-control-panel.md). It would be the right tool only if the browser called S3 or DynamoDB directly under per-user IAM policies. It also carries a regional trap: the logins-map key must exactly match the token's `iss` claim, which differs by Region |
| Skip Cognito for this route and issue our own JWT | Fewest moving parts in the exchange, but it puts a second token format and a second verifier on the API, which is what ADR-0012 exists to prevent |

## Open questions

Answered on 2026-08-11 against the documentation, see sources below:

- ~~Exact Cognito custom authentication trigger set.~~ Three triggers: define, create, verify. No password needed
  when the flow starts with `CHALLENGE_NAME: CUSTOM_CHALLENGE`. A refresh token is issued on success.
- ~~Whether an identity pool with developer-authenticated identities is simpler.~~ No. It yields temporary AWS
  credentials rather than user pool tokens, which is the wrong shape for an API-Gateway-fronted API. See the
  alternatives table.

Still open:

- Whether the token travels in the URL path or in a fragment. A fragment keeps it out of server logs and
  referrer headers, at the cost of some client-side handling. Prefer the fragment unless it complicates the
  exchange.
- Whether the owner role should be barred from chat sign-in entirely, so privileged access always comes through
  Google. Leaning yes.
- Token lifetime. One minute is the assumption; it needs to survive a slow phone opening a browser. The refresh
  token means this matters less than it first appeared.
- Whether the panel uses managed login for Google at all, given it cannot serve this route. Building both Google
  and this flow against the user pools API directly may be less work than maintaining two sign-in surfaces.

## Sources

Verified 2026-08-11.

- Custom authentication challenge Lambda triggers, and the challenge loop: <https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-lambda-challenge.html>
- Developer-authenticated identities, and what they actually return: <https://docs.aws.amazon.com/cognito/latest/developerguide/developer-authenticated-identities.html>
