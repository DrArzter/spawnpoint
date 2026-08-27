# Telegram invokes this Lambda only when somebody sends a message. There is no
# continuously running bot process and deploying it cannot start the game host.
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
      local.start_state_machine_arn,
      local.idle_watchdog_state_machine_arn,
    ]
  }

  statement {
    sid       = "SingleFlightCheck"
    actions   = ["states:ListExecutions"]
    resources = [local.start_state_machine_arn]
  }

  statement {
    sid       = "ReadHostState"
    actions   = ["ec2:DescribeInstances"]
    resources = ["*"]
  }

  statement {
    sid     = "ReadPointerAndPacks"
    actions = ["s3:GetObject"]
    resources = [
      "${data.aws_s3_bucket.releases.arn}/worlds/*",
      "${data.aws_s3_bucket.releases.arn}/packs/*",
    ]
  }

  statement {
    sid       = "ReadBotParameters"
    actions   = ["ssm:GetParameter"]
    resources = ["arn:aws:ssm:${var.aws_region}:${local.account_id}:parameter/spawnpoint/bot/*"]
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
      START_STATE_MACHINE_ARN    = local.start_state_machine_arn
      STOP_STATE_MACHINE_ARN     = local.stop_state_machine_arn
      WATCHDOG_STATE_MACHINE_ARN = local.idle_watchdog_state_machine_arn
      INSTANCE_ID                = data.aws_instance.game_host.id
      RELEASE_BUCKET             = data.aws_s3_bucket.releases.id
      WORLD_NAME                 = "world"
      CONNECTION_ADDRESS         = var.connection_address
      PANEL_ADDRESS              = var.panel_address
      ZEROTIER_NETWORK_ID        = var.zerotier_network_id
      MINI_APP_URL               = var.mini_app_url
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

resource "aws_lambda_function_url" "bot" {
  function_name      = aws_lambda_function.bot.function_name
  authorization_type = "NONE"
}

# Since October 2025 AWS requires both permissions for a new public Function
# URL. The second permission cannot be used for a direct Lambda invocation.
resource "aws_lambda_permission" "bot_function_url" {
  statement_id           = "FunctionURLAllowPublicAccess"
  action                 = "lambda:InvokeFunctionUrl"
  function_name          = aws_lambda_function.bot.function_name
  principal              = "*"
  function_url_auth_type = "NONE"
}

resource "aws_lambda_permission" "bot_invoke_via_url" {
  statement_id             = "FunctionURLInvokeAllowPublicAccess"
  action                   = "lambda:InvokeFunction"
  function_name            = aws_lambda_function.bot.function_name
  principal                = "*"
  invoked_via_function_url = true
}
