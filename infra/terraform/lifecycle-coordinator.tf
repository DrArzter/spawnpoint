locals {
  lifecycle_coordinator_archive = "${path.module}/../../lambdas/dist/lifecycle-coordinator.zip"
  lifecycle_coordinator_table_actions = [
    "dynamodb:GetItem",
    "dynamodb:PutItem",
    # Host records (ADR-0054) share the table under a prefixed key; the fleet
    # is read with a filtered scan until its size earns an index.
    "dynamodb:Scan",
  ]
}

data "aws_iam_policy_document" "lambda_assume_role" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "lifecycle_coordinator" {
  name               = "spawnpoint-lifecycle-coordinator-v2"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json

  tags = {
    Name = "spawnpoint-lifecycle-coordinator-v2"
  }
}

resource "aws_cloudwatch_log_group" "lifecycle_coordinator" {
  name              = "/aws/lambda/spawnpoint-lifecycle-coordinator-v2"
  retention_in_days = 14

  tags = {
    Name = "spawnpoint-lifecycle-coordinator-v2"
  }
}

data "aws_iam_policy_document" "lifecycle_coordinator" {
  statement {
    sid       = "CoordinateOnlyLifecycleV2"
    actions   = local.lifecycle_coordinator_table_actions
    resources = [aws_dynamodb_table.lifecycle_v2.arn]
  }

  statement {
    sid = "WriteOnlyOwnLogs"
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = ["${aws_cloudwatch_log_group.lifecycle_coordinator.arn}:*"]
  }
}

resource "aws_iam_role_policy" "lifecycle_coordinator" {
  name   = "spawnpoint-lifecycle-coordinator-v2"
  role   = aws_iam_role.lifecycle_coordinator.id
  policy = data.aws_iam_policy_document.lifecycle_coordinator.json
}

resource "aws_lambda_function" "lifecycle_coordinator" {
  function_name = "spawnpoint-lifecycle-coordinator-v2"
  description   = "Atomic Lifecycle V2 transitions; inert until V2 workflows receive invoke permission."
  role          = aws_iam_role.lifecycle_coordinator.arn
  runtime       = "nodejs24.x"
  handler       = "index.handler"
  architectures = ["x86_64"]
  memory_size   = 128
  timeout       = 10

  filename = local.lifecycle_coordinator_archive
  source_code_hash = fileexists(local.lifecycle_coordinator_archive) ? filebase64sha256(
    local.lifecycle_coordinator_archive
  ) : base64sha256("run npm ci --include=dev and npm run build in lambdas")

  environment {
    variables = {
      LIFECYCLE_TABLE_NAME = aws_dynamodb_table.lifecycle_v2.name
    }
  }

  depends_on = [
    aws_iam_role_policy.lifecycle_coordinator,
    aws_cloudwatch_log_group.lifecycle_coordinator,
  ]

  tags = {
    Name    = "spawnpoint-lifecycle-coordinator-v2"
    Purpose = "lifecycle-v2-atomic-transitions"
  }
}
