locals {
  world_lifecycle_function_arn = "arn:aws:lambda:${var.aws_region}:${data.aws_caller_identity.current.account_id}:function:spawnpoint-world-lifecycle"
  sync_events_arn              = "arn:aws:events:${var.aws_region}:${data.aws_caller_identity.current.account_id}:rule/StepFunctionsGetEventsForStepFunctionsExecutionRule"
}

resource "aws_iam_role" "world_lifecycle" {
  name               = "spawnpoint-world-lifecycle"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json
}

resource "aws_iam_role_policy_attachment" "world_lifecycle_logs" {
  role       = aws_iam_role.world_lifecycle.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

data "aws_iam_policy_document" "world_lifecycle" {
  statement {
    sid     = "ReadWorldPresetAndPointer"
    actions = ["s3:GetObject"]
    resources = [
      "${data.aws_s3_bucket.releases.arn}/worlds/*/world.json",
      "${data.aws_s3_bucket.releases.arn}/worlds/*/release.json",
      "${data.aws_s3_bucket.releases.arn}/worlds/*/purges/*.json",
      "${data.aws_s3_bucket.releases.arn}/presets/*/catalog.json",
    ]
  }

  statement {
    sid     = "UpdateWorldAndPointer"
    actions = ["s3:PutObject"]
    resources = [
      "${data.aws_s3_bucket.releases.arn}/worlds/*/world.json",
      "${data.aws_s3_bucket.releases.arn}/worlds/*/release.json",
      "${data.aws_s3_bucket.releases.arn}/worlds/*/purges/*.json",
    ]
  }

  statement {
    sid       = "ListWorldBackups"
    actions   = ["s3:ListBucket", "s3:ListBucketVersions"]
    resources = [data.aws_s3_bucket.backups.arn]
    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["worlds/*/archives/*"]
    }
  }

  statement {
    sid       = "PurgeWorldBackups"
    actions   = ["s3:DeleteObject", "s3:DeleteObjectVersion"]
    resources = ["${data.aws_s3_bucket.backups.arn}/worlds/*/archives/*"]
  }

  statement {
    sid       = "ListWorldReleaseVersions"
    actions   = ["s3:ListBucketVersions"]
    resources = [data.aws_s3_bucket.releases.arn]
    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["worlds/*/world.json", "worlds/*/release.json"]
    }
  }

  statement {
    sid     = "PurgeWorldRegistryAndPointer"
    actions = ["s3:DeleteObject", "s3:DeleteObjectVersion"]
    resources = [
      "${data.aws_s3_bucket.releases.arn}/worlds/*/world.json",
      "${data.aws_s3_bucket.releases.arn}/worlds/*/release.json",
    ]
  }
}

resource "aws_iam_role_policy" "world_lifecycle" {
  name   = "spawnpoint-world-lifecycle"
  role   = aws_iam_role.world_lifecycle.id
  policy = data.aws_iam_policy_document.world_lifecycle.json
}

resource "aws_cloudwatch_log_group" "world_lifecycle" {
  name              = "/aws/lambda/spawnpoint-world-lifecycle"
  retention_in_days = 14
}

resource "aws_lambda_function" "world_lifecycle" {
  function_name    = "spawnpoint-world-lifecycle"
  role             = aws_iam_role.world_lifecycle.arn
  runtime          = "nodejs22.x"
  handler          = "index.handler"
  filename         = data.archive_file.world_lifecycle.output_path
  source_code_hash = data.archive_file.world_lifecycle.output_base64sha256
  timeout          = 30
  memory_size      = 256

  environment {
    variables = {
      RELEASE_BUCKET = data.aws_s3_bucket.releases.id
      BACKUP_BUCKET  = data.aws_s3_bucket.backups.id
    }
  }

  depends_on = [aws_cloudwatch_log_group.world_lifecycle]
}

data "aws_iam_policy_document" "world_lifecycle_workflow_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["states.amazonaws.com"]
    }
    condition {
      test     = "ArnEquals"
      variable = "aws:SourceArn"
      values   = [local.world_lifecycle_arn]
    }
  }
}

resource "aws_iam_role" "world_lifecycle_workflow" {
  name               = "spawnpoint-world-lifecycle-workflow"
  assume_role_policy = data.aws_iam_policy_document.world_lifecycle_workflow_assume.json
}

data "aws_iam_policy_document" "world_lifecycle_workflow" {
  statement {
    actions   = ["lambda:InvokeFunction"]
    resources = [aws_lambda_function.world_lifecycle.arn]
  }
  statement {
    actions   = ["states:StartExecution"]
    resources = [local.stop_state_machine_arn]
  }
  statement {
    actions   = ["states:DescribeExecution", "states:StopExecution"]
    resources = ["arn:aws:states:${var.aws_region}:${data.aws_caller_identity.current.account_id}:execution:spawnpoint-stop-server:*"]
  }
  statement {
    actions   = ["events:PutRule", "events:PutTargets", "events:DescribeRule"]
    resources = [local.sync_events_arn]
  }
}

resource "aws_iam_role_policy" "world_lifecycle_workflow" {
  name   = "spawnpoint-world-lifecycle-workflow"
  role   = aws_iam_role.world_lifecycle_workflow.id
  policy = data.aws_iam_policy_document.world_lifecycle_workflow.json
}

resource "aws_sfn_state_machine" "world_lifecycle" {
  name     = "spawnpoint-world-lifecycle"
  role_arn = aws_iam_role.world_lifecycle_workflow.arn
  type     = "STANDARD"
  definition = templatefile("${path.module}/../../workflows/world-lifecycle.asl.json.tftpl", {
    stop_state_machine_arn       = local.stop_state_machine_arn
    world_lifecycle_function_arn = aws_lambda_function.world_lifecycle.arn
  })
}
