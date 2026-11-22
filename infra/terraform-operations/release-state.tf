data "archive_file" "release_state" {
  type        = "zip"
  source_dir  = "${path.module}/../../lambdas/dist/release-state"
  output_path = "${path.module}/../../lambdas/dist/release-state.zip"
}

locals {
  release_state_refs_table_name = "spawnpoint-release-refs"
  release_state_refs_table_arn  = "arn:aws:dynamodb:${var.aws_region}:${local.account_id}:table/${local.release_state_refs_table_name}"
}

data "aws_iam_policy_document" "release_state_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "release_state" {
  name               = "spawnpoint-release-state"
  assume_role_policy = data.aws_iam_policy_document.release_state_assume.json
}

resource "aws_iam_role_policy_attachment" "release_state_logs" {
  role       = aws_iam_role.release_state.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

data "aws_iam_policy_document" "release_state" {
  statement {
    sid     = "ReadCurrentWipeAndLegacyMigrationSource"
    actions = ["s3:GetObject"]
    resources = [
      "${data.aws_s3_bucket.releases.arn}/worlds/*/generations/*/release.json",
      "${data.aws_s3_bucket.releases.arn}/worlds/*/release.json",
    ]
  }

  # A pointer names no game or preset. The world's record gives them, so the
  # holder of the release can be found (ADR-0080).
  statement {
    sid       = "ReadWorldRecordForHolder"
    actions   = ["s3:GetObject"]
    resources = ["${data.aws_s3_bucket.releases.arn}/worlds/*/world.json"]
  }

  # Holder first: a transition adds its generation's holder to the release
  # items before it writes the pointer. Release items and holders only; the
  # leading key keeps file items out of reach, and nothing here deletes.
  statement {
    sid       = "HoldReleaseState"
    actions   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem"]
    resources = [local.release_state_refs_table_arn]
    condition {
      test     = "ForAllValues:StringLike"
      variable = "dynamodb:LeadingKeys"
      values   = ["release#*"]
    }
  }
  statement {
    sid       = "WriteCurrentWipeState"
    actions   = ["s3:PutObject"]
    resources = ["${data.aws_s3_bucket.releases.arn}/worlds/*/generations/*/release.json"]
  }

  # A promotion names the archive it keeps (ADR-0030). The key and checksum
  # come from the listing, so the archive itself is never read.
  statement {
    sid       = "ListWipeArchivesForPrePromotionBackup"
    actions   = ["s3:ListBucket"]
    resources = [local.backup_bucket_arn]
    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["worlds/*/archives/*"]
    }
  }
}

resource "aws_iam_role_policy" "release_state" {
  name   = "spawnpoint-release-state"
  role   = aws_iam_role.release_state.id
  policy = data.aws_iam_policy_document.release_state.json
}

resource "aws_cloudwatch_log_group" "release_state" {
  name              = "/aws/lambda/spawnpoint-release-state"
  retention_in_days = 14
}

resource "aws_lambda_function" "release_state" {
  function_name    = "spawnpoint-release-state"
  role             = aws_iam_role.release_state.arn
  runtime          = "nodejs22.x"
  handler          = "index.handler"
  filename         = data.archive_file.release_state.output_path
  source_code_hash = data.archive_file.release_state.output_base64sha256
  timeout          = 10
  memory_size      = 256

  environment {
    variables = {
      RELEASE_BUCKET = data.aws_s3_bucket.releases.id
      BACKUP_BUCKET  = "spawnpoint-backups-${local.account_id}"

      RELEASE_REFS_TABLE = local.release_state_refs_table_name
    }
  }

  depends_on = [aws_cloudwatch_log_group.release_state]
}
