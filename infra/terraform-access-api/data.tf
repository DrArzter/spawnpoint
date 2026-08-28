data "aws_caller_identity" "current" {}

data "aws_dynamodb_table" "access" {
  name = "spawnpoint-access"
}

data "aws_iam_policy_document" "lambda_assume_role" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

data "archive_file" "access_api" {
  type        = "zip"
  source_dir  = "${path.module}/../../lambdas/dist/access-api"
  output_path = "${path.module}/../../lambdas/dist/access-api.zip"
}
