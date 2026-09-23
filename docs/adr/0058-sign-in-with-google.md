# ADR-0058 — Sign in with Google as one more proof-based provider, off until configured

- Status: Accepted — implemented in the same change, 2026-09-23
- Date: 2026-09-23
- Milestone: M4
- Extends: [ADR-0045](0045-provider-neutral-login-sessions.md), [ADR-0055](0055-sign-in-with-email-and-password-by-default.md)
  and [ADR-0057](0057-link-login-providers-through-the-current-identity.md)

## Context

The browser panel signs in with an email and password or through Telegram, and every way in ends in the same
provider-neutral session (ADR-0045). Telegram's browser login is already an OpenID Connect ID token verified against the
provider's published keys. Google offers the same shape: Google Identity Services returns an RS256 ID token to the page
that asked for it, signed by keys Google publishes, for an OAuth client the deployment owns.

Every browser provider is optional. The one running deployment has a Telegram client because the bot that runs the group
already needed one; a clone may have none of them, or Google only. Whatever is not configured must be absent, not broken:
no route that answers 401, no button that leads nowhere.

## Decision

Google is a `LoginProvider` beside Telegram and password, with the id `google`, in `lambdas/src/access/google-login-provider.ts`.

The verification that both Telegram and Google need moved into `lambdas/src/access/oidc.ts`: three-part token, `RS256`
with a `kid`, an issuer from the provider's known set, an audience equal to the client id, unexpired, issued no later
than thirty seconds from now and no earlier than ten minutes ago, and a signature that verifies under the published key
(one forced refetch of the key set for an unknown `kid`, then refusal). Each provider states its issuer set and key URL;
Google's is both spellings of `accounts.google.com` and `https://www.googleapis.com/oauth2/v3/certs`. Telegram keeps its
numeric-client-id guard and its own reading of the claims. Every failure is `null`: a forged token and a stale one are
refused alike.

The principal's subject is Google's `sub`, never the email address: people change addresses and keep accounts. The email
is carried only when `email_verified` is `true`. The display name is `name`, then `given_name`, then the address's local
part. No client secret exists in this flow; the client id is a public value.

The browser uses Google's own rendered button, in outline on the light theme and black on the dark one, at the width of
its row. Google's brand rules allow no other control for this flow. The token goes to `POST /auth/google` for a session,
or to `POST /me/accounts/google` to link the account to the current Identity (ADR-0057). Both routes are declared in the
API Gateway route set like every other, so the routing test still holds the handler and the deployment to one list.

A provider is on exactly when its public client id is set:

| Where | Telegram | Google | Password |
|---|---|---|---|
| Terraform (`infra/terraform-access-api`) | `telegram_oidc_client_id` | `google_oidc_client_id` | `password_login_enabled` |
| Repository variable | `TELEGRAM_OIDC_CLIENT_ID` | `GOOGLE_OIDC_CLIENT_ID` | `PASSWORD_LOGIN_ENABLED` |
| Lambda environment | `TELEGRAM_OIDC_CLIENT_ID` | `GOOGLE_OIDC_CLIENT_ID` | `PASSWORD_LOGIN_ENABLED` |
| Web build | `VITE_TELEGRAM_OIDC_CLIENT_ID` | `VITE_GOOGLE_OIDC_CLIENT_ID` | — (read from the API) |

Off, a provider is missing from `GET /auth/providers` and from the linkable list, its sign-in route answers
`404 not_found` the way an undeployed adapter does, and the panel draws no button. `scripts/deploy-web.sh` reads both
client ids from the Terraform outputs when they exist and publishes without them otherwise; only the API URL remains
required there. The same rule now applies to Telegram's browser listing: without a client id the API does not advertise
it, though `POST /auth/telegram` stays deployed for the Mini App's `initData` and the legacy widget signature.

## Consequences

- Enabling Google is a console task, not a code change: create an OAuth client of type **Web application** in the Google
  Cloud console, put the exact panel origin under **Authorised JavaScript origins** (no redirect URI: the library returns
  the token to the page), set `GOOGLE_OIDC_CLIENT_ID` as a repository variable, apply, and redeploy the web build. The
  consent screen needs an app name and, for accounts outside the owning organisation, publishing or test users.
- A first Google sign-in creates an observed Visitor exactly as a first Telegram sign-in does; roles still come from an
  Owner. An Identity that already exists links Google from its profile and then signs in either way.
- Google accounts without a verified address arrive with `email: null`; nothing downstream may assume a provider account
  carries an email.
- The flow sends no nonce. A stolen token is bounded by the ten-minute freshness window and by the audience check,
  which refuses tokens minted for any other client; a nonce would need a server-issued value before the button is
  drawn, which can follow if a threat model asks for it.
- The verifier is shared: a future Discord or GitHub OIDC provider is an issuer set, a key URL and a reading of claims.
