# Access state

This isolated Terraform root owns the shared DynamoDB identity, account-link, role, subscription and onboarding-candidate store. It is deliberately separate from compute so an access change cannot replace the game host.

```bash
terraform init -backend-config=backend.hcl
terraform plan -out=access.tfplan
terraform apply access.tfplan
```

The table holds observed Telegram access candidates, approved identities with their roles and direct grants, notification subscriptions and invitation delivery claims. The access API in [`../terraform-access-api`](../terraform-access-api/) and the bot in [`../terraform-bot`](../terraform-bot/) read the same authority.
