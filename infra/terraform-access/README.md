# Access state

This isolated Terraform root owns the shared DynamoDB identity, account-link, role, subscription and onboarding-candidate store. It is deliberately separate from compute so an access change cannot replace the game host.

```bash
terraform init -backend-config=backend.hcl
terraform plan -out=access.tfplan
terraform apply access.tfplan
```

The first deployed slice stores only observed Telegram access candidates. Identity approval and the authenticated control-plane API are added on top of the same table.
