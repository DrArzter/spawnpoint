# Applies ADR-0010's 5/2/2 per world and generation. It may delete only a
# current archive version; the backup bucket keeps the noncurrent version for
# 30 days (../terraform-storage), so a wrong delete is recoverable.
locals {
  backup_bucket_arn = "arn:aws:s3:::spawnpoint-backups-${local.account_id}"
}

data "archive_file" "backup_retention" {
  type        = "zip"
  source_dir  = "${path.module}/../../lambdas/dist/backup-retention"
  output_path = "${path.module}/../../lambdas/dist/backup-retention.zip"
}

data "aws_iam_policy_document" "backup_retention_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "backup_retention" {
  name               = "spawnpoint-backup-retention"
  assume_role_policy = data.aws_iam_policy_document.backup_retention_assume.json
}

resource "aws_iam_role_policy_attachment" "backup_retention_logs" {
  role       = aws_iam_role.backup_retention.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

data "aws_iam_policy_document" "backup_retention" {
  statement {
    sid       = "ListWorldArchives"
    actions   = ["s3:ListBucket"]
    resources = [local.backup_bucket_arn]
    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["worlds/", "worlds/*/archives/*"]
    }
  }

  statement {
    sid       = "DeleteOnlyArchives"
    actions   = ["s3:DeleteObject"]
    resources = ["${local.backup_bucket_arn}/worlds/*/archives/*"]
  }

  statement {
    sid       = "ReadWorldRecords"
    actions   = ["s3:GetObject"]
    resources = ["${data.aws_s3_bucket.releases.arn}/worlds/*/world.json"]
  }

  # Each wipe's pointer names the pre-promotion backup no plan may remove.
  statement {
    sid       = "ReadPrePromotionBackups"
    actions   = ["s3:GetObject"]
    resources = ["${data.aws_s3_bucket.releases.arn}/worlds/*/generations/*/release.json"]
  }
}

resource "aws_iam_role_policy" "backup_retention" {
  name   = "spawnpoint-backup-retention"
  role   = aws_iam_role.backup_retention.id
  policy = data.aws_iam_policy_document.backup_retention.json
}

resource "aws_cloudwatch_log_group" "backup_retention" {
  name              = "/aws/lambda/spawnpoint-backup-retention"
  retention_in_days = 14
}

resource "aws_lambda_function" "backup_retention" {
  function_name    = "spawnpoint-backup-retention"
  role             = aws_iam_role.backup_retention.arn
  runtime          = "nodejs22.x"
  handler          = "index.handler"
  filename         = data.archive_file.backup_retention.output_path
  source_code_hash = data.archive_file.backup_retention.output_base64sha256
  timeout          = 300
  memory_size      = 256

  environment {
    variables = {
      BACKUP_BUCKET  = "spawnpoint-backups-${local.account_id}"
      RELEASE_BUCKET = data.aws_s3_bucket.releases.id
    }
  }

  depends_on = [aws_cloudwatch_log_group.backup_retention]
}

resource "aws_cloudwatch_event_rule" "backup_retention" {
  name                = "spawnpoint-backup-retention"
  description         = "Apply 5/2/2 backup retention per world and generation (ADR-0010)."
  schedule_expression = "cron(30 4 * * ? *)"
}

resource "aws_cloudwatch_event_target" "backup_retention" {
  rule = aws_cloudwatch_event_rule.backup_retention.name
  arn  = aws_lambda_function.backup_retention.arn
}

resource "aws_lambda_permission" "backup_retention" {
  statement_id  = "AllowScheduledBackupRetention"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.backup_retention.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.backup_retention.arn
}

resource "aws_cloudwatch_metric_alarm" "backup_retention_failed" {
  alarm_name          = "spawnpoint-backup-retention-failed"
  alarm_description   = "Backup retention failed for at least one world; its archives were left as they were. Check /aws/lambda/spawnpoint-backup-retention."
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  dimensions          = { FunctionName = aws_lambda_function.backup_retention.function_name }
  statistic           = "Sum"
  period              = 3600
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [data.aws_sns_topic.fleet_alerts.arn]
  ok_actions          = [data.aws_sns_topic.fleet_alerts.arn]
}
