# Access and onboarding AWS command log

This log records the commands used to inspect and deploy Spawnpoint's identity/access storage. It contains no credentials or bot secrets.

## Verify the caller

```bash
aws sts get-caller-identity --profile spawnpoint
```

Shows which AWS account and IAM principal subsequent commands will use. It does not modify AWS.

## Plan and create the isolated access table

```bash
cd infra/terraform-access
terraform init -backend-config=backend.hcl
terraform plan -out=access.tfplan
terraform apply access.tfplan
```

The saved plan is important: review that it says `1 to add, 0 to change, 0 to destroy`, then apply that exact file. This root is intentionally separate from compute, so it cannot replace the game host.

## Inspect access candidates

```bash
aws dynamodb query \
  --profile spawnpoint \
  --region eu-central-1 \
  --table-name spawnpoint-access \
  --index-name gsi1 \
  --key-condition-expression 'gsi1pk = :state' \
  --expression-attribute-values '{":state":{"S":"CANDIDATE#REQUESTED"}}'
```

Returns people who pressed `Request access` in a private Telegram chat. Use `CANDIDATE#OBSERVED` to inspect people who opened the bot but have not requested access.

## Verify table protection

```bash
aws dynamodb describe-table \
  --profile spawnpoint \
  --region eu-central-1 \
  --table-name spawnpoint-access \
  --query 'Table.{status:TableStatus,billing:BillingModeSummary.BillingMode,deletionProtection:DeletionProtectionEnabled,indexes:GlobalSecondaryIndexes[].IndexName}'

aws dynamodb describe-continuous-backups \
  --profile spawnpoint \
  --region eu-central-1 \
  --table-name spawnpoint-access
```

The first command checks table state, on-demand billing, deletion protection and indexes. The second confirms point-in-time recovery.

## Deploy the bot integration

```bash
npm run build --prefix lambdas
cd infra/terraform-bot
terraform plan -out=bot-access.tfplan
terraform apply bot-access.tfplan
```

The reviewed plan updates only the existing bot Lambda and its inline IAM policy. The bot receives `dynamodb:UpdateItem` only on `spawnpoint-access`; it cannot scan identities or grant roles.
