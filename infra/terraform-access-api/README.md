# Access API and browser identity

This isolated root owns browser sign-in adapters, revocable login sessions, the session-protected HTTP API and its Lambda. It reads the access table but cannot affect game compute.

The Lambda verifies either an OIDC ID token against Telegram's public JWKS or Mini App `initData` with the bot token, then issues one short-lived Spawnpoint session format. The legacy Login Widget signature remains accepted only for rolling compatibility. Spawnpoint roles, not successful Telegram authentication, decide what the caller may do.

1. In BotFather, open **Login Widget**, switch to OpenID Connect, keep the default `RS256` signing algorithm and add the exact `panel_url` origin under **Trusted Origins** (for example `https://spawnpoint.example.dev`, without a path). Also register the exact page URL under **Redirect URLs** (for example `https://spawnpoint.example.dev/`): the popup library uses the current origin and pathname as its `redirect_uri` while returning the ID token to the opener.
2. Copy the public numeric Client ID into `telegram_oidc_client_id`. The popup flow does not use the Client Secret; never put it in Terraform, GitHub variables or the browser build.
3. A successful login returns a 15-minute access token kept only in memory and sets a rotating, 30-day `HttpOnly` refresh cookie. DynamoDB stores only its hash and revocation state; explicit sign-out revokes it.
4. Ensure `bot_token_parameter` exists as a SecureString for Telegram verification and `session_signing_secret_parameter` exists as a separate SecureString for provider-neutral Spawnpoint access tokens.
5. For a same-site production cookie, set `api_domain_name` and `dns_zone_name`; leaving both unset retains an execute-api endpoint with a cross-site-compatible cookie for self-hosted installations.
6. Copy `terraform.tfvars.example` to ignored `terraform.tfvars` and set the explicitly chosen bootstrap Owner Telegram ID.
7. Apply, then deploy the web build. `scripts/deploy-web.sh` reads the API URL and public OIDC Client ID from Terraform outputs.

Any Telegram account may authenticate and becomes an observed Visitor. It receives no operational access until an Owner approves it. The configured Telegram account atomically claims the first Owner once.

Email and password is the second sign-in adapter ([ADR-0055](../../docs/adr/0055-sign-in-with-email-and-password-by-default.md)), on by default and switched off with `password_login_enabled = false`. Anonymous registration is independent and closed by default; open it deliberately with `password_registration_enabled = true`, then close it without locking out existing credentials. `POST /auth/password/register` creates a credential — the address as a sign-in name, the password as a salted scrypt hash in the access table — and signs in; the account is observed like a Telegram one and holds no role until an Owner approves it. Nothing is sent to the address, so it is listed as unverified. `GET /auth/providers` tells the panel both which adapters this deployment offers and which accept self-registration. Both public scrypt routes have their own API Gateway burst and steady-state throttles. Ten wrong guesses lock an address for fifteen minutes, with conditional writes preserving every concurrent failure.
