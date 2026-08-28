# Access API and browser identity

This isolated root owns Telegram browser and Mini App sign-in, the session-protected HTTP API and its Lambda. It reads the access table but cannot affect game compute.

The Lambda verifies either the official Login Widget signature or Mini App `initData`, then issues one short-lived Spawnpoint session format. Spawnpoint roles, not successful Telegram authentication, decide what the caller may do.

1. In BotFather, open the bot's **Web Login** settings and register `dwk99t8cin0cf.cloudfront.net`.
2. Ensure `/spawnpoint/bot/token` already exists as a SecureString; do not copy the token into Terraform.
3. Copy `terraform.tfvars.example` to ignored `terraform.tfvars` and set the explicitly chosen bootstrap Owner Telegram ID.
4. Apply, then deploy the web build. `scripts/deploy-web.sh` reads the API URL and bot username from Terraform outputs.

Any Telegram account may authenticate and becomes an observed Visitor. It receives no operational access until an Owner approves it. The configured Telegram account atomically claims the first Owner once.
