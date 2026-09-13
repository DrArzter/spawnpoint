# Access API and browser identity

This isolated root owns Telegram browser and Mini App sign-in, the session-protected HTTP API and its Lambda. It reads the access table but cannot affect game compute.

The Lambda verifies either an OIDC ID token against Telegram's public JWKS or Mini App `initData` with the bot token, then issues one short-lived Spawnpoint session format. The legacy Login Widget signature remains accepted only for rolling compatibility. Spawnpoint roles, not successful Telegram authentication, decide what the caller may do.

1. In BotFather, open **Login Widget**, switch to OpenID Connect, keep the default `RS256` signing algorithm and add the exact `panel_url` origin under **Trusted Origins** (for example `https://spawnpoint.example.dev`, without a path). Also register the exact page URL under **Redirect URLs** (for example `https://spawnpoint.example.dev/`): the popup library uses the current origin and pathname as its `redirect_uri` while returning the ID token to the opener.
2. Copy the public numeric Client ID into `telegram_oidc_client_id`. The popup flow does not use the Client Secret; never put it in Terraform, GitHub variables or the browser build.
3. Ensure `/spawnpoint/bot/token` already exists as a SecureString; it signs Spawnpoint sessions and verifies Mini App `initData`.
4. Copy `terraform.tfvars.example` to ignored `terraform.tfvars` and set the explicitly chosen bootstrap Owner Telegram ID.
5. Apply, then deploy the web build. `scripts/deploy-web.sh` reads the API URL and public OIDC Client ID from Terraform outputs.

Any Telegram account may authenticate and becomes an observed Visitor. It receives no operational access until an Owner approves it. The configured Telegram account atomically claims the first Owner once.
