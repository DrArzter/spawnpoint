# Notifications are deliberately a second slice. Keeping the definitions in
# this root establishes one owner, while the false default keeps the first bot
# deployment to the command surface only.
data "archive_file" "notifier_bundle" {
  count       = var.enable_notifications ? 1 : 0
  type        = "zip"
  source_dir  = "${path.module}/../../lambdas/dist/notifier"
  output_path = "${path.module}/../../lambdas/dist/notifier.zip"
}

data "aws_sns_topic" "alerts" {
  count = var.enable_notifications ? 1 : 0
  name  = "spawnpoint-alert"
}

resource "aws_iam_role" "notifier" {
  count              = var.enable_notifications ? 1 : 0
  name               = "spawnpoint-notifier"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json
}

resource "aws_iam_role_policy_attachment" "notifier_logs" {
  count      = var.enable_notifications ? 1 : 0
  role       = aws_iam_role.notifier[0].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

data "aws_iam_policy_document" "notifier" {
  count = var.enable_notifications ? 1 : 0

  statement {
    sid       = "ReadBotParameters"
    actions   = ["ssm:GetParameter"]
    resources = ["arn:aws:ssm:${var.aws_region}:${local.account_id}:parameter/spawnpoint/bot/*"]
  }
}

resource "aws_iam_role_policy" "notifier" {
  count  = var.enable_notifications ? 1 : 0
  name   = "spawnpoint-notifier"
  role   = aws_iam_role.notifier[0].id
  policy = data.aws_iam_policy_document.notifier[0].json
}

resource "aws_lambda_function" "notifier" {
  count            = var.enable_notifications ? 1 : 0
  function_name    = "spawnpoint-notifier"
  role             = aws_iam_role.notifier[0].arn
  runtime          = "nodejs22.x"
  handler          = "index.handler"
  filename         = data.archive_file.notifier_bundle[0].output_path
  source_code_hash = data.archive_file.notifier_bundle[0].output_base64sha256
  timeout          = 10
  memory_size      = 128

  environment {
    variables = {
      BOT_TOKEN_PARAMETER = "/spawnpoint/bot/token"
      CHAT_IDS_PARAMETER  = "/spawnpoint/bot/chat-ids"
    }
  }
}

resource "aws_cloudwatch_event_rule" "execution_notifications" {
  count       = var.enable_notifications ? 1 : 0
  name        = "spawnpoint-execution-notifications"
  description = "Spawnpoint workflow status changes delivered to Telegram."

  event_pattern = jsonencode({
    source        = ["aws.states"]
    "detail-type" = ["Step Functions Execution Status Change"]
    detail = {
      stateMachineArn = [
        local.start_state_machine_arn,
        local.stop_state_machine_arn,
        local.idle_watchdog_state_machine_arn,
        "arn:aws:states:${var.aws_region}:${local.account_id}:stateMachine:spawnpoint-promote-release",
        "arn:aws:states:${var.aws_region}:${local.account_id}:stateMachine:spawnpoint-build-release",
      ]
      status = ["RUNNING", "SUCCEEDED", "FAILED", "TIMED_OUT", "ABORTED"]
    }
  })
}

resource "aws_cloudwatch_event_target" "execution_notifications" {
  count = var.enable_notifications ? 1 : 0
  rule  = aws_cloudwatch_event_rule.execution_notifications[0].name
  arn   = aws_lambda_function.notifier[0].arn
}

resource "aws_lambda_permission" "notifier_events" {
  count         = var.enable_notifications ? 1 : 0
  statement_id  = "AllowEventBridge"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.notifier[0].function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.execution_notifications[0].arn
}

resource "aws_sns_topic_subscription" "alerts_to_chat" {
  count     = var.enable_notifications ? 1 : 0
  topic_arn = data.aws_sns_topic.alerts[0].arn
  protocol  = "lambda"
  endpoint  = aws_lambda_function.notifier[0].arn
}

resource "aws_lambda_permission" "notifier_sns" {
  count         = var.enable_notifications ? 1 : 0
  statement_id  = "AllowGuardrailsTopic"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.notifier[0].function_name
  principal     = "sns.amazonaws.com"
  source_arn    = data.aws_sns_topic.alerts[0].arn
}
