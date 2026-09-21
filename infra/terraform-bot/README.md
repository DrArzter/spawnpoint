# Telegram control surface

This isolated Terraform root owns only the command bot: its IAM role, Lambda,
Function URL and URL permissions. It discovers the existing host, release
bucket and Lifecycle V2 workflows without owning or modifying them. Therefore a
bot plan cannot replace EC2, detach EBS or alter a state machine.

The Lambda is invoked only by Telegram webhooks; no bot compute runs between
messages. `/start` only opens the menu, `/server_start` starts the Lifecycle V2
start, which registers the session's watchdog itself; `/status` is read-only, and `/pack` returns a
short-lived presigned S3 link when one exists. `/network` gives the ZeroTier join
command, while `/address` gives the stable Minecraft and session-scoped Grafana
addresses. Telegram's webhook secret gates the public Function URL, then the
shared access table resolves the Telegram account to one Spawnpoint identity and checks the command's permission.

Secrets live in SSM; identities and roles live in the shared DynamoDB access table:

- `/spawnpoint/bot/token` (`SecureString`)
- `/spawnpoint/bot/webhook-secret` (`SecureString`)
- `/spawnpoint/bot/chat-ids` (`String`, reserved for the later notifier)
- `/spawnpoint/email/resend-api-key` (`SecureString`, optional send-only key when `email_delivery_provider = "resend"`)

Transactional email is an optional notifier adapter. The default `email_delivery_provider = "none"` keeps a clone
free of external email dependencies. A Resend deployment additionally sets `email_from` to an address on a verified
sending domain and may set `email_reply_to`; neither address is a secret. Only the parameter name enters Terraform.
The notifier sends game invitations to individually verified linked addresses and uses a stable idempotency key per
invitation and recipient.

Set `mini_app_url` explicitly to the public HTTPS endpoint for this installation. The hosted pipeline reads it from the
`SPAWNPOINT_MINI_APP_URL` repository variable; self-hosted deployments may use their custom domain, generated CloudFront
URL or another public HTTPS endpoint.

Build and verify before planning:

```bash
cd ../../lambdas
npm test
npm run typecheck
npm run build

cd ../infra/terraform-bot
terraform init -backend-config=backend.hcl
terraform plan -var='mini_app_url=https://spawnpoint.example.dev/' -out=bot.tfplan
terraform show bot.tfplan
terraform apply bot.tfplan
```

Create `backend.hcl` from the example with account `614934752397`. The expected
first production plan is additive only: seven resources, zero changes and zero
destroys. Registering the Telegram webhook is a separate explicit step after
the URL exists; applying Terraform alone does not send a message or start EC2.
