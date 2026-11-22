# ADR-0080's retirement of one release. The access API invokes it asynchronously
# after the owner typed the confirmation. It reads every source of truth for a
# live check, changes the reference table, and removes the retired release from
# its preset catalog. Its role has no s3:Delete* and no write to any object but
# the catalog: only the reconciler role may delete under objects/.
data "archive_file" "release_retirement" {
  type        = "zip"
  source_dir  = "${path.module}/../../lambdas/dist/release-retirement"
  output_path = "${path.module}/../../lambdas/dist/release-retirement.zip"
}

data "aws_iam_policy_document" "release_retirement_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "release_retirement" {
  name               = "spawnpoint-release-retirement"
  assume_role_policy = data.aws_iam_policy_document.release_retirement_assume.json
}

resource "aws_iam_role_policy_attachment" "release_retirement_logs" {
  role       = aws_iam_role.release_retirement.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

data "aws_iam_policy_document" "release_retirement" {
  # Without ListBucket, S3 answers 403 for a missing manifest or catalog.
  # Names only: no object of objects/ is ever read.
  statement {
    sid       = "ListReleaseBucket"
    actions   = ["s3:ListBucket"]
    resources = [data.aws_s3_bucket.releases.arn]
    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["releases/*", "worlds/*", "presets/*"]
    }
  }

  # The live check reads world records, pointers and catalogs, and the manifest
  # of the release it retires.
  statement {
    sid     = "ReadReleaseSources"
    actions = ["s3:GetObject"]
    resources = [
      "${data.aws_s3_bucket.releases.arn}/releases/*",
      "${data.aws_s3_bucket.releases.arn}/worlds/*",
      "${data.aws_s3_bucket.releases.arn}/presets/*",
    ]
  }

  # The one object it writes: the catalog, under If-Match, to drop the release.
  statement {
    sid       = "WritePresetCatalog"
    actions   = ["s3:PutObject"]
    resources = ["${data.aws_s3_bucket.releases.arn}/presets/*/catalog.json"]
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

  # Holders, back-references and file counters. Transactions are authorised by
  # these item actions. This table only.
  statement {
    sid       = "ChangeReferenceTable"
    actions   = ["dynamodb:GetItem", "dynamodb:Query", "dynamodb:UpdateItem", "dynamodb:DeleteItem"]
    resources = [local.release_refs_table_arn]
  }
}

resource "aws_iam_role_policy" "release_retirement" {
  name   = "spawnpoint-release-retirement"
  role   = aws_iam_role.release_retirement.id
  policy = data.aws_iam_policy_document.release_retirement.json
}

resource "aws_cloudwatch_log_group" "release_retirement" {
  name              = "/aws/lambda/spawnpoint-release-retirement"
  retention_in_days = 30
}

resource "aws_lambda_function" "release_retirement" {
  function_name    = "spawnpoint-release-retirement"
  role             = aws_iam_role.release_retirement.arn
  runtime          = "nodejs22.x"
  handler          = "index.handler"
  filename         = data.archive_file.release_retirement.output_path
  source_code_hash = data.archive_file.release_retirement.output_base64sha256
  timeout          = 900
  memory_size      = 512

  environment {
    variables = {
      BACKUP_BUCKET      = "spawnpoint-backups-${local.account_id}"
      RELEASE_BUCKET     = data.aws_s3_bucket.releases.id
      RELEASE_REFS_TABLE = local.release_refs_table_name
    }
  }

  depends_on = [aws_cloudwatch_log_group.release_retirement]
}

resource "aws_cloudwatch_metric_alarm" "release_retirement_errors" {
  alarm_name          = "spawnpoint-release-retirement-errors"
  alarm_description   = "A release retirement raised an error and may be left in state retiring. Check /aws/lambda/spawnpoint-release-retirement, then request it again: a repeat resumes."
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  dimensions          = { FunctionName = aws_lambda_function.release_retirement.function_name }
  statistic           = "Sum"
  period              = 3600
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [data.aws_sns_topic.fleet_alerts.arn]
  ok_actions          = [data.aws_sns_topic.fleet_alerts.arn]
}
