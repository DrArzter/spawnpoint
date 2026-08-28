# Telegram control surface

This isolated Terraform root owns only the command bot: its IAM role, Lambda,
Function URL and URL permissions. It discovers the existing host, release
bucket and V1 lifecycle workflows without owning or modifying them. Therefore a
bot plan cannot replace EC2, detach EBS or alter a state machine.

The Lambda is invoked only by Telegram webhooks; no bot compute runs between
messages. `/start` only opens the menu, `/server_start` starts the established
V1 start and watchdog workflows, `/status` is read-only, and `/pack` returns a
short-lived presigned S3 link when one exists. `/network` gives the ZeroTier join
command, while `/address` gives the stable Minecraft and session-scoped Grafana
addresses. Telegram's webhook secret gates the public Function URL, then the
shared access table resolves the Telegram account to one Spawnpoint identity and checks the command's permission.

Secrets live in SSM; identities and roles live in the shared DynamoDB access table:

- `/spawnpoint/bot/token` (`SecureString`)
- `/spawnpoint/bot/webhook-secret` (`SecureString`)
- `/spawnpoint/bot/chat-ids` (`String`, reserved for the later notifier)

Build and verify before planning:

```bash
cd ../../lambdas
npm test
npm run typecheck
npm run build

cd ../infra/terraform-bot
terraform init -backend-config=backend.hcl
terraform plan -out=bot.tfplan
terraform show bot.tfplan
terraform apply bot.tfplan
```

Create `backend.hcl` from the example with account `614934752397`. The expected
first production plan is additive only: seven resources, zero changes and zero
destroys. Registering the Telegram webhook is a separate explicit step after
the URL exists; applying Terraform alone does not send a message or start EC2.
