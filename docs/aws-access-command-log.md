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

## Game invitations

On 2026-08-29 invitations stopped being UI-only. An authenticated identity with
`invitation.send` can load a deliberately narrow directory containing only an
identity ID and display name. The API excludes the caller and validates the
same rule again when a direct invitation is created.

Each accepted request writes an immutable `INVITATION#<uuid> / EVENT` record to
`spawnpoint-access`, then publishes a `spawnpoint.access / Game Invitation`
event to the default EventBridge bus. The access Lambda may only call
`events:PutEvents` on that one bus; Telegram delivery remains owned by the
notifier Lambda.

Validation and deployment:

```bash
npm test --prefix lambdas
npm run typecheck --prefix lambdas
npm run build --prefix lambdas
npm run build --prefix web

cd infra/terraform-access-api
terraform plan -out=access-invitations.tfplan
terraform apply access-invitations.tfplan

cd ../terraform-bot
terraform plan -var enable_notifications=true -out=bot-invitations.tfplan
terraform apply bot-invitations.tfplan
```

The reviewed access plan was `2 add / 2 change / 0 destroy`; the notifier plan
was `3 add / 1 change / 0 destroy`. Always pass
`enable_notifications=true` when operating the production bot root. Omitting
it intentionally describes the pre-notifier configuration and therefore
produces a destructive plan. Both post-apply plans returned `No changes`, and
the game EC2 instance remained `stopped`.

A safe smoke test calls `GET /invitations/recipients` with a short-lived local
session and does not publish an event. It returned one recipient and confirmed
that the current Owner was absent. Do not smoke-test the POST route casually:
that is a real invitation and may send Telegram messages.

The next slice added delivery receipts. New records use a sender/game/world GSI
partition so `GET /games/{gameId}/worlds/{worldId}/invitations` returns the five
latest attempts by the current identity without scanning other players or
worlds. The browser labels `READY` as queued and does not call it delivered
until the notifier records the outcome.

The recipient directory now also returns delivery readiness. It exposes only
whether direct invitations are enabled and whether the identity has a usable
private Telegram chat; chat IDs and subscription records remain private. The
panel keeps unavailable identities visible, explains how they can become
reachable, and prevents selecting them. The notifier still rechecks both facts
when delivery starts because readiness can change after the directory loads.

The production update changed only the existing access Lambda (`0 add / 1
change / 0 destroy`) and the static web assets. A safe read-only smoke test
returned HTTP 200 with one `notifications_off` identity. It printed only counts
per readiness state, did not create an invitation, and sent no Telegram
message. The post-apply Terraform plan returned `No changes`; the game EC2
instance remained `stopped`.
