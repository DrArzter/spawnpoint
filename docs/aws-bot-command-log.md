# AWS Telegram bot command log

Executed on 2026-08-26/27 against account `614934752397`, region
`eu-central-1`, profile `spawnpoint`. Secret values are intentionally replaced
with shell variables or placeholders. The root `.env` is ignored by Git and
was parsed as data; it was never sourced as shell code.

## Identity and secret parameters

The bot was verified with Telegram `getMe` as `@drarzterbot`. After the owner
sent `/start`, `getUpdates` identified Telegram user and private chat
`1780660807`. The four SSM parameters are:

```bash
aws ssm put-parameter \
  --profile spawnpoint --region eu-central-1 \
  --name /spawnpoint/bot/token \
  --type SecureString --value "$bot_token" --overwrite

aws ssm put-parameter \
  --profile spawnpoint --region eu-central-1 \
  --name /spawnpoint/bot/webhook-secret \
  --type SecureString --value "$webhook_secret" --overwrite

aws ssm put-parameter \
  --profile spawnpoint --region eu-central-1 \
  --name /spawnpoint/bot/allow-list \
  --type String --value 1780660807 --overwrite

aws ssm put-parameter \
  --profile spawnpoint --region eu-central-1 \
  --name /spawnpoint/bot/chat-ids \
  --type String --value 1780660807 --overwrite
```

`token` and `webhook-secret` are `SecureString`; `allow-list` and `chat-ids`
contain only numeric Telegram identifiers. Parameter metadata was read back
without decrypting or printing either secret.

## Isolated deployment

The command surface was moved out of the broad host root into
`infra/terraform-bot`, with the independent backend key
`spawnpoint/bot.tfstate`. The notifier definitions live in the same root but
remain disabled by `enable_notifications = false` for this first slice.

```bash
cd lambdas
npm test
npm run typecheck
npm run build

terraform -chdir=../infra/terraform-bot init \
  -reconfigure -backend-config=backend.hcl
terraform -chdir=../infra/terraform-bot validate
terraform -chdir=../infra/terraform-bot plan -out=bot.tfplan
terraform -chdir=../infra/terraform-bot apply bot.tfplan
terraform -chdir=../infra/terraform-bot plan -detailed-exitcode
```

The reviewed first plan was exactly `7 add / 0 change / 0 destroy`:

- one IAM role, one managed logging-policy attachment and one inline
  least-privilege policy;
- one Node.js 22 Lambda;
- one Function URL;
- the two public URL permissions AWS requires for URLs created after October
  2025. Direct public Lambda invocation is excluded by
  `invoked_via_function_url = true`.

The post-apply plan returned `No changes`. No EC2, EBS, DynamoDB or Step
Functions resource appeared in the plan, and applying it did not start an
execution.

## Webhook registration

There were three old `/start` messages in the Telegram polling queue. They
were deliberately discarded while the webhook was registered, so the old
command semantics could not start EC2:

```bash
curl --silent --show-error --fail -X POST \
  "https://api.telegram.org/bot${bot_token}/setWebhook" \
  --data-urlencode "url=${bot_webhook_url}" \
  --data-urlencode "secret_token=${webhook_secret}" \
  --data "drop_pending_updates=true" \
  --data 'allowed_updates=["message","callback_query"]'
```

`callback_query` is required for inline buttons; limiting this list to only
`message` makes the menu render but silently drops every button press.
`getWebhookInfo` reported a configured URL, no custom certificate and zero
pending updates. Neither the token, webhook secret nor full URL needs to be
printed during routine checks.

## Command semantics and acceptance

The first smoke exposed two defects before real use:

1. `/start` incorrectly meant “start EC2”; it now only displays the bot menu.
   The explicit operational command is `/server_start`.
2. grammY's Node platform code could not run from the original ESM bundle due
   to a dynamic `require("http")`. The bot is now packaged as a single
   `index.cjs` CommonJS bundle.

The repair plan was exactly `0 add / 1 change / 0 destroy`, changing only the
Lambda code hash, followed by `No changes`. A signed end-to-end smoke sent
`/start` and `/status` through the Function URL. Both returned HTTP 200. Before
and after the two calls:

```text
EC2 state:                 stopped -> stopped
running start executions: 0 -> 0
```

Thus pressing Telegram's standard Start button cannot start the game host.
The registered Telegram command menu is `/start`, `/status`, `/server_start`,
and `/pack`.

The visible `/start` response also has an inline menu, adapted from the local
`openai-telegram-bot` navigation pattern without copying its polling, FSM or
database architecture:

- `Server status` and `Client pack` are read-only callbacks;
- `Start server` opens a confirmation screen;
- only the second `Start server` confirmation begins the workflow, while `Cancel` edits the
  existing message back to the main menu;
- callbacks pass through the same numeric SSM allow-list as slash commands.

The explicit `/server_start` command also opens the confirmation screen rather
than immediately starting EC2. This keeps both discoverable UI paths safe from
an accidental tap or command completion.

## Player onboarding commands

The bot owns the small facts players otherwise keep asking the operator for:

| Command | Answer |
|---|---|
| `/network` | ZeroTier network ID, ready Linux join command, Windows/macOS GUI path, manual authorization reminder |
| `/address` | Minecraft and session-scoped Grafana addresses, plus their ZeroTier/running-host prerequisites |
| `/help` | The full inline menu |

The Network ID and overlay addresses are configuration, not credentials. They
are supplied to Lambda as `ZEROTIER_NETWORK_ID`, `CONNECTION_ADDRESS` and
`PANEL_ADDRESS`; actual network admission remains a separate owner action in
ZeroTier Central.

After deployment, Telegram's command menu was updated to `start`, `help`,
`status`, `address`, `network`, `server_start`, and `pack`. Signed end-to-end
smokes for `/network` and `/address` both returned HTTP 200, while EC2 remained
`stopped` before and after.

## Chat UI polish

The next UI-only deployment kept the same commands and safety boundaries, but
made the bot behave like a small control panel:

- callback navigation edits one HTML-formatted card instead of filling chat
  history with a response for every tap;
- status has Refresh and only offers Copy address while the host is running;
- the address card copies Minecraft and Grafana endpoints directly;
- the ZeroTier card copies either the network ID or the full Linux join
  command;
- the pack URL lives behind a Download button, while its expiry and install
  instructions remain visible in the card.

After visual review, decorative emoji were removed from cards, buttons and
automatic notifications. Cards retain Telegram HTML only for restrained bold
headings and monospace values; machine notifications use textual markers such
as `[READY]`, `[STOPPED]` and `[ALARM]`.

Telegram's `copy_text` inline buttons copy locally in the client and never call
Lambda. The Start menu remains informational, and starting AWS still requires
the separate confirmation callback.

The UI bundle was checked and deployed on 2026-08-27 with:

```bash
cd lambdas
npm test
npm run typecheck
npm run build

terraform -chdir=../infra/terraform-bot validate
terraform -chdir=../infra/terraform-bot plan -out=bot-ui.tfplan
terraform -chdir=../infra/terraform-bot apply bot-ui.tfplan
terraform -chdir=../infra/terraform-bot plan -detailed-exitcode
```

The saved plan and apply were exactly `0 add / 1 change / 0 destroy`: only the
existing bot Lambda's `source_code_hash` changed. The post-apply plan returned
`No changes`. A signed `/start` webhook smoke returned HTTP 200, its Lambda
invocation completed without an application error, and EC2 state remained
`stopped`. The Node.js runtime emitted a non-fatal dependency warning for the
deprecated built-in `punycode` module; this is not a failed update or handler
error, but should disappear when the transitive dependency is upgraded.

## Safe status checks

```bash
aws lambda get-function \
  --profile spawnpoint --region eu-central-1 \
  --function-name spawnpoint-telegram-bot \
  --query 'Configuration.{State:State,LastUpdateStatus:LastUpdateStatus,Runtime:Runtime}'

aws logs tail /aws/lambda/spawnpoint-telegram-bot \
  --profile spawnpoint --region eu-central-1 \
  --since 10m --format short

aws ec2 describe-instances \
  --profile spawnpoint --region eu-central-1 \
  --instance-ids i-09c9b5069308ac372 \
  --query 'Reservations[0].Instances[0].State.Name' --output text
```

Do not paste the BotFather token into a command history and do not run
`source .env`. Read the one exact variable and validate its shape instead.

## Separate browser entry point

On 2026-08-28 the main menu gained a second panel entry. `Open panel` remains
Telegram's `web_app` button, while `Open panel in browser` is a normal HTTPS
URL button to the same CloudFront application. This gives desktop clients a
usable escape hatch when their embedded WebView is missing or undesirable.

The Lambda bundle passed tests, TypeScript checking and the production build.
The reviewed Terraform plan was exactly `0 add / 1 change / 0 destroy`, with
only `aws_lambda_function.bot.source_code_hash` changing. The saved plan was
applied and the post-apply plan returned `No changes`.
