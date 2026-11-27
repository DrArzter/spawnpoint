# ADR-0102, step 3: Spot for a launched host whose sessions are all cold, of
# games that declare it. The start workflow asks for Spot only while both this
# switch and the session volume are on, and falls back to on demand when Spot
# has no capacity.

locals {
  spot_template_vars = {
    spot = var.spot
  }
}

# EC2 launches Spot capacity through this service-linked role. The start role
# may not create IAM roles, so Terraform creates it with the switch. An account
# can already have it (from the console, or an earlier Spot request), so an
# existing one is adopted, never created twice. Turning the switch off again
# deletes it; AWS refuses that while Spot instances still use it.
data "aws_iam_roles" "spot_service_linked" {
  count       = var.spot == "enabled" ? 1 : 0
  path_prefix = "/aws-service-role/spot.amazonaws.com/"
}

import {
  for_each = toset(try(data.aws_iam_roles.spot_service_linked[0].arns, []))
  to       = aws_iam_service_linked_role.ec2_spot[0]
  id       = each.value
}

resource "aws_iam_service_linked_role" "ec2_spot" {
  count            = var.spot == "enabled" ? 1 : 0
  aws_service_name = "spot.amazonaws.com"
  description      = "EC2 Spot capacity for Spawnpoint launched hosts (ADR-0102)."
}

# The first deploy created the role but could not tag it, which left this
# address tainted. Forget it without deleting the role; the import above
# adopts the same role under ec2_spot.
removed {
  from = aws_iam_service_linked_role.spot

  lifecycle {
    destroy = false
  }
}

# ADR-0102, step 5: what an interruption does in the control plane. The
# warning marks each session on the host as moving; the host's termination
# starts each one again with its session volume. A host's own report is only
# logged. Nothing exists while the switch is off.
locals {
  spot_interruption_count = var.spot == "enabled" ? 1 : 0
  spot_interruption_events = {
    warning = {
      source        = ["aws.ec2"]
      "detail-type" = ["EC2 Spot Instance Interruption Warning"]
    }
    terminated = {
      source        = ["aws.ec2"]
      "detail-type" = ["EC2 Instance State-change Notification"]
      detail        = { state = ["terminated"] }
    }
    saved = {
      source        = ["spawnpoint.host"]
      "detail-type" = ["Sessions saved for interruption"]
    }
  }
}

data "archive_file" "spot_interruption" {
  type        = "zip"
  source_dir  = "${path.module}/../../lambdas/dist/spot-interruption"
  output_path = "${path.module}/../../lambdas/dist/spot-interruption.zip"
}

data "aws_iam_policy_document" "spot_interruption_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "spot_interruption" {
  count              = local.spot_interruption_count
  name               = "spawnpoint-spot-interruption"
  assume_role_policy = data.aws_iam_policy_document.spot_interruption_assume.json
}

resource "aws_iam_role_policy_attachment" "spot_interruption_logs" {
  count      = local.spot_interruption_count
  role       = aws_iam_role.spot_interruption[0].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

data "aws_iam_policy_document" "spot_interruption" {
  statement {
    sid       = "MoveSessionsInTheLifecycle"
    actions   = ["dynamodb:GetItem", "dynamodb:PutItem"]
    resources = [data.aws_dynamodb_table.lifecycle.arn]
  }

  statement {
    sid       = "FindSessionVolumes"
    actions   = ["ec2:DescribeVolumes"]
    resources = ["*"]
  }

  statement {
    sid       = "ReadWhatTheStartWasGiven"
    actions   = ["states:DescribeExecution"]
    resources = ["arn:aws:states:${var.aws_region}:${local.account_id}:execution:${aws_sfn_state_machine.lifecycle_v2_watchdog.name}:*"]
  }

  statement {
    sid       = "StartTheMove"
    actions   = ["states:StartExecution"]
    resources = [aws_sfn_state_machine.lifecycle_v2_start.arn]
  }

  statement {
    sid       = "TellPanelsASessionMoves"
    actions   = ["events:PutEvents"]
    resources = ["arn:aws:events:${var.aws_region}:${local.account_id}:event-bus/default"]
  }
}

resource "aws_iam_role_policy" "spot_interruption" {
  count  = local.spot_interruption_count
  name   = "spawnpoint-spot-interruption"
  role   = aws_iam_role.spot_interruption[0].id
  policy = data.aws_iam_policy_document.spot_interruption.json
}

resource "aws_cloudwatch_log_group" "spot_interruption" {
  count             = local.spot_interruption_count
  name              = "/aws/lambda/spawnpoint-spot-interruption"
  retention_in_days = 14
}

resource "aws_lambda_function" "spot_interruption" {
  count            = local.spot_interruption_count
  function_name    = "spawnpoint-spot-interruption"
  role             = aws_iam_role.spot_interruption[0].arn
  runtime          = "nodejs22.x"
  handler          = "index.handler"
  filename         = data.archive_file.spot_interruption.output_path
  source_code_hash = data.archive_file.spot_interruption.output_base64sha256
  timeout          = 60
  memory_size      = 256

  environment {
    variables = {
      LIFECYCLE_TABLE_NAME    = data.aws_dynamodb_table.lifecycle.name
      START_STATE_MACHINE_ARN = aws_sfn_state_machine.lifecycle_v2_start.arn
    }
  }

  depends_on = [aws_cloudwatch_log_group.spot_interruption]
}

resource "aws_cloudwatch_event_rule" "spot_interruption" {
  for_each      = { for name, pattern in local.spot_interruption_events : name => jsonencode(pattern) if var.spot == "enabled" }
  name          = "spawnpoint-spot-interruption-${each.key}"
  description   = "ADR-0102: a Spot interruption, ${each.key}. The Lambda acts only on hosts the fleet registered."
  event_pattern = each.value
}

resource "aws_cloudwatch_event_target" "spot_interruption" {
  for_each = aws_cloudwatch_event_rule.spot_interruption
  rule     = each.value.name
  arn      = aws_lambda_function.spot_interruption[0].arn
}

resource "aws_lambda_permission" "spot_interruption" {
  for_each      = aws_cloudwatch_event_rule.spot_interruption
  statement_id  = "AllowSpotInterruption-${each.key}"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.spot_interruption[0].function_name
  principal     = "events.amazonaws.com"
  source_arn    = each.value.arn
}

resource "aws_cloudwatch_metric_alarm" "spot_interruption_failed" {
  count               = local.spot_interruption_count
  alarm_name          = "spawnpoint-spot-interruption-failed"
  alarm_description   = "A Spot interruption could not be handled: a session may not move. Check /aws/lambda/spawnpoint-spot-interruption."
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  dimensions          = { FunctionName = aws_lambda_function.spot_interruption[0].function_name }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [data.aws_sns_topic.fleet_alerts.arn]
  ok_actions          = [data.aws_sns_topic.fleet_alerts.arn]
}
