data "aws_caller_identity" "current" {}

data "aws_dynamodb_table" "access" {
  name = "spawnpoint-access"
}

data "aws_dynamodb_table" "lifecycle" {
  name = "spawnpoint-lifecycle-v2"
}

data "aws_s3_bucket" "releases" {
  bucket = "spawnpoint-releases-${data.aws_caller_identity.current.account_id}"
}

locals {
  watchdog_state_machine_arn = "arn:aws:states:${var.aws_region}:${data.aws_caller_identity.current.account_id}:stateMachine:spawnpoint-idle-watchdog"
  operation_state_machines = [
    { type = "start", arn = "arn:aws:states:${var.aws_region}:${data.aws_caller_identity.current.account_id}:stateMachine:spawnpoint-start-server" },
    { type = "stop", arn = "arn:aws:states:${var.aws_region}:${data.aws_caller_identity.current.account_id}:stateMachine:spawnpoint-stop-server" },
    { type = "promote", arn = "arn:aws:states:${var.aws_region}:${data.aws_caller_identity.current.account_id}:stateMachine:spawnpoint-promote-release" },
    # Publishing an uploaded pack writes a release and touches no host, so it is
    # startable but never listed as an operation in progress.
    { type = "publishPack", arn = "arn:aws:states:${var.aws_region}:${data.aws_caller_identity.current.account_id}:stateMachine:spawnpoint-publish-uploaded-pack" },
  ]
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
