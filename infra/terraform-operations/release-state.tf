data "archive_file" "release_state" {
  type        = "zip"
  source_dir  = "${path.module}/../../lambdas/dist/release-state"
  output_path = "${path.module}/../../lambdas/dist/release-state.zip"
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
  statement {
    sid       = "WriteCurrentWipeState"
    actions   = ["s3:PutObject"]
    resources = ["${data.aws_s3_bucket.releases.arn}/worlds/*/generations/*/release.json"]
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
    variables = { RELEASE_BUCKET = data.aws_s3_bucket.releases.id }
  }

  depends_on = [aws_cloudwatch_log_group.release_state]
}
