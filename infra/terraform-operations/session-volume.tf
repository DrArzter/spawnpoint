# ADR-0102: a session volume carries one tag that marks it as Spawnpoint's and
# one that names its session. Every IAM grant on a volume, the workflows that
# create and find it, and the sweeper use these values; the sweeper's own
# constants (lambdas/src/domain/session-volume.ts) are kept equal by a test.
locals {
  session_volume_managed_by   = "spawnpoint-session-volume"
  session_volume_session_tag  = "SessionId"
  session_volume_unmount_doc  = "arn:aws:ssm:${var.aws_region}:${local.account_id}:document/spawnpoint-unmount-session-volume"
  session_volume_arn_pattern  = "arn:aws:ec2:${var.aws_region}:${local.account_id}:volume/*"
  session_volume_host_pattern = "arn:aws:ec2:${var.aws_region}:${local.account_id}:instance/*"
  session_volume_template_vars = {
    session_volume             = var.session_volume
    session_volume_size_gib    = var.session_volume_size_gib
    session_volume_managed_by  = local.session_volume_managed_by
    session_volume_session_tag = local.session_volume_session_tag
  }
}

# The release after a verified archive: unmount on a host that keeps running,
# detach, delete. The start's compensation and the stop both run it.
data "aws_iam_policy_document" "session_volume_release" {
  statement {
    sid       = "FindSessionVolumes"
    actions   = ["ec2:DescribeVolumes"]
    resources = ["*"]
  }

  statement {
    sid       = "DetachSessionVolumes"
    actions   = ["ec2:DetachVolume"]
    resources = [local.session_volume_arn_pattern]

    condition {
      test     = "StringEquals"
      variable = "ec2:ResourceTag/ManagedBy"
      values   = [local.session_volume_managed_by]
    }
  }

  statement {
    sid       = "DetachFromLaunchedHosts"
    actions   = ["ec2:DetachVolume"]
    resources = [local.session_volume_host_pattern]

    condition {
      test     = "StringEquals"
      variable = "ec2:ResourceTag/ManagedBy"
      values   = ["spawnpoint-fleet"]
    }
  }

  statement {
    sid       = "DeleteSessionVolumes"
    actions   = ["ec2:DeleteVolume"]
    resources = [local.session_volume_arn_pattern]

    condition {
      test     = "StringEquals"
      variable = "ec2:ResourceTag/ManagedBy"
      values   = [local.session_volume_managed_by]
    }
  }

  statement {
    sid       = "UnmountThroughItsDocument"
    actions   = ["ssm:SendCommand"]
    resources = [local.session_volume_unmount_doc]
  }

  statement {
    sid       = "UnmountOnLaunchedHosts"
    actions   = ["ssm:SendCommand"]
    resources = [local.session_volume_host_pattern]

    condition {
      test     = "StringEquals"
      variable = "ssm:resourceTag/ManagedBy"
      values   = ["spawnpoint-fleet"]
    }
  }

  statement {
    sid       = "ReadUnmountResult"
    actions   = ["ssm:GetCommandInvocation"]
    resources = ["*"]
  }
}

# The start creates the volume tagged, and attaches it only to a launched host.
data "aws_iam_policy_document" "session_volume_create" {
  statement {
    sid       = "CreateTaggedSessionVolumes"
    actions   = ["ec2:CreateVolume"]
    resources = [local.session_volume_arn_pattern]

    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/ManagedBy"
      values   = [local.session_volume_managed_by]
    }
  }

  statement {
    sid       = "TagSessionVolumesAtCreation"
    actions   = ["ec2:CreateTags"]
    resources = [local.session_volume_arn_pattern]

    condition {
      test     = "StringEquals"
      variable = "ec2:CreateAction"
      values   = ["CreateVolume"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/ManagedBy"
      values   = [local.session_volume_managed_by]
    }
  }

  statement {
    sid       = "AttachSessionVolumes"
    actions   = ["ec2:AttachVolume"]
    resources = [local.session_volume_arn_pattern]

    condition {
      test     = "StringEquals"
      variable = "ec2:ResourceTag/ManagedBy"
      values   = [local.session_volume_managed_by]
    }
  }

  statement {
    sid       = "AttachToLaunchedHosts"
    actions   = ["ec2:AttachVolume"]
    resources = [local.session_volume_host_pattern]

    condition {
      test     = "StringEquals"
      variable = "ec2:ResourceTag/ManagedBy"
      values   = ["spawnpoint-fleet"]
    }
  }
}

resource "aws_iam_role_policy" "lifecycle_v2_start_session_volume" {
  name   = "spawnpoint-start-server-v2-session-volume"
  role   = aws_iam_role.lifecycle_v2_start.id
  policy = data.aws_iam_policy_document.lifecycle_v2_start_session_volume.json
}

data "aws_iam_policy_document" "lifecycle_v2_start_session_volume" {
  source_policy_documents = [
    data.aws_iam_policy_document.session_volume_create.json,
    data.aws_iam_policy_document.session_volume_release.json,
  ]
}

resource "aws_iam_role_policy" "lifecycle_v2_stop_session_volume" {
  name   = "spawnpoint-stop-server-v2-session-volume"
  role   = aws_iam_role.lifecycle_v2_stop.id
  policy = data.aws_iam_policy_document.session_volume_release.json
}

# The backstop (ADR-0102): every 15 minutes, delete each available session
# volume whose session is not live. A volume that survives a sweep fails the
# run, and the alarm below reports it. It runs whether or not the switch is on,
# so volumes left after switching off are still let go.
data "archive_file" "session_volume_sweeper" {
  type        = "zip"
  source_dir  = "${path.module}/../../lambdas/dist/session-volume-sweeper"
  output_path = "${path.module}/../../lambdas/dist/session-volume-sweeper.zip"
}

data "aws_iam_policy_document" "session_volume_sweeper_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "session_volume_sweeper" {
  name               = "spawnpoint-session-volume-sweeper"
  assume_role_policy = data.aws_iam_policy_document.session_volume_sweeper_assume.json
}

resource "aws_iam_role_policy_attachment" "session_volume_sweeper_logs" {
  role       = aws_iam_role.session_volume_sweeper.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

data "aws_iam_policy_document" "session_volume_sweeper" {
  statement {
    sid       = "FindSessionVolumes"
    actions   = ["ec2:DescribeVolumes"]
    resources = ["*"]
  }

  statement {
    sid       = "ReadWorldLifecycle"
    actions   = ["dynamodb:GetItem"]
    resources = [data.aws_dynamodb_table.lifecycle.arn]
  }

  statement {
    sid       = "DeleteOnlySessionVolumes"
    actions   = ["ec2:DeleteVolume"]
    resources = [local.session_volume_arn_pattern]

    condition {
      test     = "StringEquals"
      variable = "ec2:ResourceTag/ManagedBy"
      values   = [local.session_volume_managed_by]
    }
  }
}

resource "aws_iam_role_policy" "session_volume_sweeper" {
  name   = "spawnpoint-session-volume-sweeper"
  role   = aws_iam_role.session_volume_sweeper.id
  policy = data.aws_iam_policy_document.session_volume_sweeper.json
}

resource "aws_cloudwatch_log_group" "session_volume_sweeper" {
  name              = "/aws/lambda/spawnpoint-session-volume-sweeper"
  retention_in_days = 14
}

resource "aws_lambda_function" "session_volume_sweeper" {
  function_name    = "spawnpoint-session-volume-sweeper"
  role             = aws_iam_role.session_volume_sweeper.arn
  runtime          = "nodejs22.x"
  handler          = "index.handler"
  filename         = data.archive_file.session_volume_sweeper.output_path
  source_code_hash = data.archive_file.session_volume_sweeper.output_base64sha256
  timeout          = 60
  memory_size      = 256

  environment {
    variables = {
      LIFECYCLE_TABLE_NAME = data.aws_dynamodb_table.lifecycle.name
    }
  }

  depends_on = [aws_cloudwatch_log_group.session_volume_sweeper]
}

resource "aws_cloudwatch_event_rule" "session_volume_sweep" {
  name                = "spawnpoint-session-volume-sweep"
  description         = "Delete session volumes whose session is not live (ADR-0102)."
  schedule_expression = "rate(15 minutes)"
}

resource "aws_cloudwatch_event_target" "session_volume_sweep" {
  rule = aws_cloudwatch_event_rule.session_volume_sweep.name
  arn  = aws_lambda_function.session_volume_sweeper.arn
}

resource "aws_lambda_permission" "session_volume_sweep" {
  statement_id  = "AllowScheduledSessionVolumeSweep"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.session_volume_sweeper.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.session_volume_sweep.arn
}

resource "aws_cloudwatch_metric_alarm" "session_volume_survived" {
  alarm_name          = "spawnpoint-session-volume-survived"
  alarm_description   = "A session volume survived a sweep: it could not be deleted, stays attached with no live session, or names no session. Each one is billed. Check /aws/lambda/spawnpoint-session-volume-sweeper."
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  dimensions          = { FunctionName = aws_lambda_function.session_volume_sweeper.function_name }
  statistic           = "Sum"
  period              = 900
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [data.aws_sns_topic.fleet_alerts.arn]
  ok_actions          = [data.aws_sns_topic.fleet_alerts.arn]
}
