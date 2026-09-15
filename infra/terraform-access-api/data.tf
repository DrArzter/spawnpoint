data "aws_caller_identity" "current" {}

data "aws_route53_zone" "api" {
  count        = local.custom_api_domain_enabled ? 1 : 0
  name         = var.dns_zone_name
  private_zone = false
}

data "aws_dynamodb_table" "access" {
  name = "spawnpoint-access"
}

data "aws_dynamodb_table" "lifecycle" {
  name = "spawnpoint-lifecycle-v2"
}

data "aws_s3_bucket" "backups" {
  bucket = "spawnpoint-backups-${data.aws_caller_identity.current.account_id}"
}

data "aws_s3_bucket" "releases" {
  bucket = "spawnpoint-releases-${data.aws_caller_identity.current.account_id}"
}

locals {
  custom_api_domain_enabled    = var.api_domain_name != null && var.api_domain_name != ""
  stop_state_machine_arn       = "arn:aws:states:${var.aws_region}:${data.aws_caller_identity.current.account_id}:stateMachine:spawnpoint-stop-server-v2"
  world_lifecycle_arn          = "arn:aws:states:${var.aws_region}:${data.aws_caller_identity.current.account_id}:stateMachine:spawnpoint-world-lifecycle"
  control_plane_view_table_arn = "arn:aws:dynamodb:${var.aws_region}:${data.aws_caller_identity.current.account_id}:table/${var.control_plane_view_table_name}"
  operation_state_machines = [
    { type = "start", arn = "arn:aws:states:${var.aws_region}:${data.aws_caller_identity.current.account_id}:stateMachine:spawnpoint-start-server-v2" },
    { type = "stop", arn = local.stop_state_machine_arn },
    { type = "promote", arn = "arn:aws:states:${var.aws_region}:${data.aws_caller_identity.current.account_id}:stateMachine:spawnpoint-promote-release" },
    { type = "world", arn = local.world_lifecycle_arn },
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

data "archive_file" "world_lifecycle" {
  type        = "zip"
  source_dir  = "${path.module}/../../lambdas/dist/world-lifecycle"
  output_path = "${path.module}/../../lambdas/dist/world-lifecycle.zip"
}
