# EventBridge execution events are best-effort. This periodic backstop checks
# the actual Fleet-tagged EC2 inventory against the lifecycle host ledger.
data "archive_file" "fleet_sweeper" {
  type        = "zip"
  source_dir  = "${path.module}/../../lambdas/dist/fleet-sweeper"
  output_path = "${path.module}/../../lambdas/dist/fleet-sweeper.zip"
}

data "aws_sns_topic" "fleet_alerts" {
  name = "spawnpoint-alert"
}

data "aws_iam_policy_document" "fleet_sweeper_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "fleet_sweeper" {
  name               = "spawnpoint-fleet-sweeper"
  assume_role_policy = data.aws_iam_policy_document.fleet_sweeper_assume.json
}

resource "aws_iam_role_policy_attachment" "fleet_sweeper_logs" {
  role       = aws_iam_role.fleet_sweeper.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

data "aws_iam_policy_document" "fleet_sweeper" {
  statement {
    sid       = "ObserveFleet"
    actions   = ["ec2:DescribeInstances"]
    resources = ["*"]
  }

  statement {
    sid       = "ReadHostLedger"
    actions   = ["dynamodb:GetItem"]
    resources = [data.aws_dynamodb_table.lifecycle.arn]
  }

  statement {
    sid       = "RestartFencedDrain"
    actions   = ["states:StartExecution"]
    resources = [local.lifecycle_v2_drain_arn]
  }

  statement {
    sid       = "ObserveRunningDrains"
    actions   = ["states:ListExecutions"]
    resources = [local.lifecycle_v2_drain_arn]
  }

  statement {
    sid       = "ReadRunningDrainInput"
    actions   = ["states:DescribeExecution"]
    resources = ["arn:aws:states:${var.aws_region}:${local.account_id}:execution:spawnpoint-drain-host-v2:*"]
  }

  statement {
    sid       = "RetryOnlyFleetHosts"
    actions   = ["ec2:TerminateInstances"]
    resources = ["arn:aws:ec2:${var.aws_region}:${local.account_id}:instance/*"]
    condition {
      test     = "StringEquals"
      variable = "ec2:ResourceTag/ManagedBy"
      values   = ["spawnpoint-fleet"]
    }
  }
}

resource "aws_iam_role_policy" "fleet_sweeper" {
  name   = "spawnpoint-fleet-sweeper"
  role   = aws_iam_role.fleet_sweeper.id
  policy = data.aws_iam_policy_document.fleet_sweeper.json
}

resource "aws_cloudwatch_log_group" "fleet_sweeper" {
  name              = "/aws/lambda/spawnpoint-fleet-sweeper"
  retention_in_days = 14
}

resource "aws_lambda_function" "fleet_sweeper" {
  function_name    = "spawnpoint-fleet-sweeper"
  role             = aws_iam_role.fleet_sweeper.arn
  runtime          = "nodejs22.x"
  handler          = "index.handler"
  filename         = data.archive_file.fleet_sweeper.output_path
  source_code_hash = data.archive_file.fleet_sweeper.output_base64sha256
  timeout          = 60
  memory_size      = 256

  environment {
    variables = {
      LIFECYCLE_TABLE_NAME    = data.aws_dynamodb_table.lifecycle.name
      DRAIN_STATE_MACHINE_ARN = local.lifecycle_v2_drain_arn
      DRAIN_GRACE_SECONDS     = tostring(var.drain_grace_seconds)
    }
  }

  depends_on = [aws_cloudwatch_log_group.fleet_sweeper]
}

resource "aws_cloudwatch_event_rule" "fleet_sweep" {
  name                = "spawnpoint-fleet-sweep"
  description         = "Recheck actual Fleet EC2 inventory after missed or failed drain events."
  schedule_expression = "rate(5 minutes)"
}

resource "aws_cloudwatch_event_target" "fleet_sweep" {
  rule = aws_cloudwatch_event_rule.fleet_sweep.name
  arn  = aws_lambda_function.fleet_sweeper.arn
}

resource "aws_lambda_permission" "fleet_sweep" {
  statement_id  = "AllowScheduledFleetSweep"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.fleet_sweeper.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.fleet_sweep.arn
}

resource "aws_cloudwatch_metric_alarm" "fleet_sweep_failed" {
  alarm_name          = "spawnpoint-fleet-sweep-failed"
  alarm_description   = "The Fleet inventory backstop failed or found a host requiring manual review. Check /aws/lambda/spawnpoint-fleet-sweeper."
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  dimensions          = { FunctionName = aws_lambda_function.fleet_sweeper.function_name }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 2
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [data.aws_sns_topic.fleet_alerts.arn]
  ok_actions          = [data.aws_sns_topic.fleet_alerts.arn]
}
