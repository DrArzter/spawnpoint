# ADR-0080's reconciler in report-only mode. It reads the release sources, the
# reference table and the `objects/` listing, and puts metrics. Its role has no
# write or delete on any bucket or table, so it cannot change what it checks.
# A later sweep mode adds its own permissions in its own change.
locals {
  release_refs_table_name = "spawnpoint-release-refs"
  release_refs_table_arn  = "arn:aws:dynamodb:${var.aws_region}:${local.account_id}:table/${local.release_refs_table_name}"
  reconciler_namespace    = "Spawnpoint/ReleaseReconciler"
}

data "archive_file" "release_reconciler" {
  type        = "zip"
  source_dir  = "${path.module}/../../lambdas/dist/release-reconciler"
  output_path = "${path.module}/../../lambdas/dist/release-reconciler.zip"
}

data "aws_iam_policy_document" "release_reconciler_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

# The bucket policy in ../terraform-storage names this role; keep the name.
resource "aws_iam_role" "release_reconciler" {
  name               = "spawnpoint-release-reconciler"
  assume_role_policy = data.aws_iam_policy_document.release_reconciler_assume.json
}

resource "aws_iam_role_policy_attachment" "release_reconciler_logs" {
  role       = aws_iam_role.release_reconciler.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

data "aws_iam_policy_document" "release_reconciler" {
  statement {
    sid       = "ListReleaseBucket"
    actions   = ["s3:ListBucket"]
    resources = [data.aws_s3_bucket.releases.arn]
    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["releases/", "objects/sha256/", "worlds/", "presets/"]
    }
  }

  # Objects under objects/ are listed, never read: the reconciler needs names only.
  statement {
    sid     = "ReadReleaseSources"
    actions = ["s3:GetObject"]
    resources = [
      "${data.aws_s3_bucket.releases.arn}/releases/*",
      "${data.aws_s3_bucket.releases.arn}/worlds/*",
      "${data.aws_s3_bucket.releases.arn}/presets/*",
    ]
  }

  statement {
    sid       = "ListBackupVersions"
    actions   = ["s3:ListBucketVersions"]
    resources = [local.backup_bucket_arn]
    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["worlds/*"]
    }
  }

  # HEAD with a version id needs both. The archive body is never requested.
  statement {
    sid       = "ReadArchiveMetadata"
    actions   = ["s3:GetObject", "s3:GetObjectVersion"]
    resources = ["${local.backup_bucket_arn}/worlds/*/archives/*"]
  }

  statement {
    sid       = "ReadReferenceTable"
    actions   = ["dynamodb:GetItem", "dynamodb:Query", "dynamodb:Scan"]
    resources = [local.release_refs_table_arn, "${local.release_refs_table_arn}/index/*"]
  }

  statement {
    sid       = "PutReconcilerMetrics"
    actions   = ["cloudwatch:PutMetricData"]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "cloudwatch:namespace"
      values   = [local.reconciler_namespace]
    }
  }
}

resource "aws_iam_role_policy" "release_reconciler" {
  name   = "spawnpoint-release-reconciler"
  role   = aws_iam_role.release_reconciler.id
  policy = data.aws_iam_policy_document.release_reconciler.json
}

resource "aws_cloudwatch_log_group" "release_reconciler" {
  name              = "/aws/lambda/spawnpoint-release-reconciler"
  retention_in_days = 30
}

resource "aws_lambda_function" "release_reconciler" {
  function_name    = "spawnpoint-release-reconciler"
  role             = aws_iam_role.release_reconciler.arn
  runtime          = "nodejs22.x"
  handler          = "index.handler"
  filename         = data.archive_file.release_reconciler.output_path
  source_code_hash = data.archive_file.release_reconciler.output_base64sha256
  timeout          = 900
  memory_size      = 512

  environment {
    variables = {
      BACKUP_BUCKET      = "spawnpoint-backups-${local.account_id}"
      RELEASE_BUCKET     = data.aws_s3_bucket.releases.id
      RELEASE_REFS_TABLE = local.release_refs_table_name
    }
  }

  depends_on = [aws_cloudwatch_log_group.release_reconciler]
}

resource "aws_cloudwatch_event_rule" "release_reconciler_weekly" {
  name                = "spawnpoint-release-reconciler-weekly"
  description         = "Compare releases, holders, back-references and objects (ADR-0080), report only."
  schedule_expression = "cron(0 5 ? * SUN *)"
}

resource "aws_cloudwatch_event_target" "release_reconciler_weekly" {
  rule = aws_cloudwatch_event_rule.release_reconciler_weekly.name
  arn  = aws_lambda_function.release_reconciler.arn
}

resource "aws_lambda_permission" "release_reconciler_weekly" {
  statement_id  = "AllowScheduledReleaseReconciler"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.release_reconciler.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.release_reconciler_weekly.arn
}

# The metrics come once a week, so each alarm looks at one day: it fires when the
# run puts a value above 0, and clears after a day with no data.
resource "aws_cloudwatch_metric_alarm" "release_reconciler_dangerous_diff" {
  alarm_name          = "spawnpoint-release-reconciler-dangerous-diff"
  alarm_description   = "The reconciler found a missing holder, a missing reference or a missing object. Read the class lines in /aws/lambda/spawnpoint-release-reconciler."
  namespace           = local.reconciler_namespace
  metric_name         = "DangerousDiff"
  statistic           = "Maximum"
  period              = 86400
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [data.aws_sns_topic.fleet_alerts.arn]
  ok_actions          = [data.aws_sns_topic.fleet_alerts.arn]
}

resource "aws_cloudwatch_metric_alarm" "release_reconciler_missing_object" {
  alarm_name          = "spawnpoint-release-reconciler-missing-object"
  alarm_description   = "A live release names an object that is not in S3. Read the missing_object line in /aws/lambda/spawnpoint-release-reconciler."
  namespace           = local.reconciler_namespace
  metric_name         = "MissingObject"
  statistic           = "Maximum"
  period              = 86400
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [data.aws_sns_topic.fleet_alerts.arn]
  ok_actions          = [data.aws_sns_topic.fleet_alerts.arn]
}

resource "aws_cloudwatch_metric_alarm" "release_reconciler_run_failed" {
  alarm_name          = "spawnpoint-release-reconciler-run-failed"
  alarm_description   = "The reconciler run failed and compared nothing. Check /aws/lambda/spawnpoint-release-reconciler."
  namespace           = local.reconciler_namespace
  metric_name         = "RunFailed"
  statistic           = "Maximum"
  period              = 86400
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [data.aws_sns_topic.fleet_alerts.arn]
  ok_actions          = [data.aws_sns_topic.fleet_alerts.arn]
}

# A run that could not read a source skips classes and can report no dangerous
# difference. That is not a pass, so it alarms too.
resource "aws_cloudwatch_metric_alarm" "release_reconciler_incomplete" {
  alarm_name          = "spawnpoint-release-reconciler-incomplete"
  alarm_description   = "The reconciler could not read every source, so its report is incomplete and nothing is sweepable. Check /aws/lambda/spawnpoint-release-reconciler."
  namespace           = local.reconciler_namespace
  metric_name         = "Incomplete"
  statistic           = "Maximum"
  period              = 86400
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [data.aws_sns_topic.fleet_alerts.arn]
  ok_actions          = [data.aws_sns_topic.fleet_alerts.arn]
}

resource "aws_cloudwatch_metric_alarm" "release_reconciler_errors" {
  alarm_name          = "spawnpoint-release-reconciler-errors"
  alarm_description   = "The reconciler Lambda raised an error, for example a timeout before it could put RunFailed. Check /aws/lambda/spawnpoint-release-reconciler."
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  dimensions          = { FunctionName = aws_lambda_function.release_reconciler.function_name }
  statistic           = "Sum"
  period              = 3600
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [data.aws_sns_topic.fleet_alerts.arn]
  ok_actions          = [data.aws_sns_topic.fleet_alerts.arn]
}
