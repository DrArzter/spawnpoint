# The Telegram bot: the first deployed Lambda, and the second surface after the
# owner scripts. Zero fixed compute — a webhook invoked by Telegram, nothing
# running between messages (docs/architecture.md#what-runs-when-nobody-plays).
#
# Build the bundle before planning: cd lambdas && npm install && npm run build.
# Secrets are NOT here: the bot token, webhook secret and allow-list live in
# Parameter Store under /spawnpoint/bot/*, created by hand (see the runbook).

data "archive_file" "bot_bundle" {
  type        = "zip"
  source_dir  = "${path.module}/../../lambdas/dist/bot"
  output_path = "${path.module}/../../lambdas/dist/bot.zip"
}

resource "aws_iam_role" "bot" {
  name               = "spawnpoint-telegram-bot"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json

  tags = {
    Name = "spawnpoint-telegram-bot"
  }
}

resource "aws_iam_role_policy_attachment" "bot_logs" {
  role       = aws_iam_role.bot.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

data "aws_iam_policy_document" "bot" {
  statement {
    sid     = "StartSessionMachines"
    actions = ["states:StartExecution"]
    resources = [
      aws_sfn_state_machine.start_server.arn,
      aws_sfn_state_machine.idle_watchdog.arn,
    ]
  }

  statement {
    sid       = "SingleFlightCheck"
    actions   = ["states:ListExecutions"]
    resources = [aws_sfn_state_machine.start_server.arn]
  }

  statement {
    sid       = "ReadHostState"
    actions   = ["ec2:DescribeInstances"]
    resources = ["*"]
  }

  # Presigning uses the same GetObject permission the link is signed with.
  statement {
    sid     = "ReadPointerAndPacks"
    actions = ["s3:GetObject"]
    resources = [
      "${data.aws_s3_bucket.releases.arn}/worlds/*",
      "${data.aws_s3_bucket.releases.arn}/packs/*",
    ]
  }

  statement {
    sid     = "ReadBotParameters"
    actions = ["ssm:GetParameter"]
    resources = [
      "arn:aws:ssm:${var.aws_region}:${data.aws_caller_identity.current.account_id}:parameter/spawnpoint/bot/*",
    ]
  }
}

resource "aws_iam_role_policy" "bot" {
  name   = "spawnpoint-telegram-bot"
  role   = aws_iam_role.bot.id
  policy = data.aws_iam_policy_document.bot.json
}

resource "aws_lambda_function" "bot" {
  function_name    = "spawnpoint-telegram-bot"
  role             = aws_iam_role.bot.arn
  runtime          = "nodejs22.x"
  handler          = "index.handler"
  filename         = data.archive_file.bot_bundle.output_path
  source_code_hash = data.archive_file.bot_bundle.output_base64sha256
  timeout          = 20
  memory_size      = 256

  environment {
    variables = {
      START_STATE_MACHINE_ARN    = aws_sfn_state_machine.start_server.arn
      STOP_STATE_MACHINE_ARN     = aws_sfn_state_machine.stop_server.arn
      WATCHDOG_STATE_MACHINE_ARN = aws_sfn_state_machine.idle_watchdog.arn
      INSTANCE_ID                = aws_instance.game_host.id
      RELEASE_BUCKET             = data.aws_s3_bucket.releases.id
      WORLD_NAME                 = "world"
      CONNECTION_ADDRESS         = var.connection_address
      BOT_TOKEN_PARAMETER        = "/spawnpoint/bot/token"
      WEBHOOK_SECRET_PARAMETER   = "/spawnpoint/bot/webhook-secret"
      ALLOW_LIST_PARAMETER       = "/spawnpoint/bot/allow-list"
    }
  }

  tags = {
    Name    = "spawnpoint-telegram-bot"
    Purpose = "chat-control-surface"
  }
}

# AuthType NONE is deliberate: Telegram cannot sign SigV4. The gate is the
# webhook secret token, registered at setWebhook and verified by the handler
# on every request; everything else is dropped before any AWS call is made.
resource "aws_lambda_function_url" "bot" {
  function_name      = aws_lambda_function.bot.function_name
  authorization_type = "NONE"
}

# --- Notifications: Step Functions execution events -> chat ------------------
# Step Functions publishes every Standard execution's status changes to the
# default EventBridge bus on its own; the machines carry no announce states.
# One rule, one small function, and a second platform later is just another
# target on the same rule.

data "archive_file" "notifier_bundle" {
  type        = "zip"
  source_dir  = "${path.module}/../../lambdas/dist/notifier"
  output_path = "${path.module}/../../lambdas/dist/notifier.zip"
}

resource "aws_iam_role" "notifier" {
  name               = "spawnpoint-notifier"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json

  tags = {
    Name = "spawnpoint-notifier"
  }
}

resource "aws_iam_role_policy_attachment" "notifier_logs" {
  role       = aws_iam_role.notifier.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

# The notifier needs exactly two parameters and nothing else.
data "aws_iam_policy_document" "notifier" {
  statement {
    sid     = "ReadBotParameters"
    actions = ["ssm:GetParameter"]
    resources = [
      "arn:aws:ssm:${var.aws_region}:${data.aws_caller_identity.current.account_id}:parameter/spawnpoint/bot/*",
    ]
  }
}

resource "aws_iam_role_policy" "notifier" {
  name   = "spawnpoint-notifier"
  role   = aws_iam_role.notifier.id
  policy = data.aws_iam_policy_document.notifier.json
}

resource "aws_lambda_function" "notifier" {
  function_name    = "spawnpoint-notifier"
  role             = aws_iam_role.notifier.arn
  runtime          = "nodejs22.x"
  handler          = "index.handler"
  filename         = data.archive_file.notifier_bundle.output_path
  source_code_hash = data.archive_file.notifier_bundle.output_base64sha256
  timeout          = 10
  memory_size      = 128

  environment {
    variables = {
      BOT_TOKEN_PARAMETER = "/spawnpoint/bot/token"
      CHAT_IDS_PARAMETER  = "/spawnpoint/bot/chat-ids"
    }
  }

  tags = {
    Name    = "spawnpoint-notifier"
    Purpose = "execution-events-to-chat"
  }
}

resource "aws_cloudwatch_event_rule" "execution_notifications" {
  name        = "spawnpoint-execution-notifications"
  description = "Session and release lifecycle to the group chat; the domain module decides which events stay silent."

  event_pattern = jsonencode({
    source        = ["aws.states"]
    "detail-type" = ["Step Functions Execution Status Change"]
    detail = {
      stateMachineArn = [
        aws_sfn_state_machine.start_server.arn,
        aws_sfn_state_machine.stop_server.arn,
        aws_sfn_state_machine.idle_watchdog.arn,
        aws_sfn_state_machine.promote_release.arn,
      ]
      status = ["RUNNING", "SUCCEEDED", "FAILED", "TIMED_OUT", "ABORTED"]
    }
  })
}

resource "aws_cloudwatch_event_target" "execution_notifications" {
  rule = aws_cloudwatch_event_rule.execution_notifications.name
  arn  = aws_lambda_function.notifier.arn
}

resource "aws_lambda_permission" "notifier_events" {
  statement_id  = "AllowEventBridge"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.notifier.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.execution_notifications.arn
}

# Guardrail alerts reach the same chat as everything else: the topic already
# collects the budget, cost anomalies and the running-hours alarm, so one
# subscription wires all three. Email on the same topic stays the out-of-band
# path (ADR-0020) — it works even when this function does not.
resource "aws_sns_topic_subscription" "alerts_to_chat" {
  topic_arn = data.aws_sns_topic.alerts.arn
  protocol  = "lambda"
  endpoint  = aws_lambda_function.notifier.arn
}

resource "aws_lambda_permission" "notifier_sns" {
  statement_id  = "AllowGuardrailsTopic"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.notifier.function_name
  principal     = "sns.amazonaws.com"
  source_arn    = data.aws_sns_topic.alerts.arn
}
