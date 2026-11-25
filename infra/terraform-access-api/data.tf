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
  # Composed, not looked up: the storage root creates the bucket in the same deploy, after a plan that cannot see it yet.
  avatar_bucket_name           = "spawnpoint-avatars-${data.aws_caller_identity.current.account_id}"
  avatar_bucket_arn            = "arn:aws:s3:::${local.avatar_bucket_name}"
  custom_api_domain_enabled    = var.api_domain_name != null && var.api_domain_name != ""
  stop_state_machine_arn       = "arn:aws:states:${var.aws_region}:${data.aws_caller_identity.current.account_id}:stateMachine:spawnpoint-stop-server-v2"
  world_lifecycle_arn          = "arn:aws:states:${var.aws_region}:${data.aws_caller_identity.current.account_id}:stateMachine:spawnpoint-world-lifecycle"
  build_release_arn            = "arn:aws:states:${var.aws_region}:${data.aws_caller_identity.current.account_id}:stateMachine:spawnpoint-build-release"
  control_plane_view_table_arn = "arn:aws:dynamodb:${var.aws_region}:${data.aws_caller_identity.current.account_id}:table/${var.control_plane_view_table_name}"
  release_refs_table_arn       = "arn:aws:dynamodb:${var.aws_region}:${data.aws_caller_identity.current.account_id}:table/${var.release_refs_table_name}"
  start_host_state_machine_arn = "arn:aws:states:${var.aws_region}:${data.aws_caller_identity.current.account_id}:stateMachine:spawnpoint-start-server"
  stop_host_state_machine_arn  = "arn:aws:states:${var.aws_region}:${data.aws_caller_identity.current.account_id}:stateMachine:spawnpoint-stop-server"
  operation_state_machines = [
    { type = "start", arn = "arn:aws:states:${var.aws_region}:${data.aws_caller_identity.current.account_id}:stateMachine:spawnpoint-start-server-v2" },
    { type = "stop", arn = local.stop_state_machine_arn },
    { type = "promote", arn = "arn:aws:states:${var.aws_region}:${data.aws_caller_identity.current.account_id}:stateMachine:spawnpoint-promote-release" },
    { type = "world", arn = local.world_lifecycle_arn },
    { type = "host", arn = "arn:aws:states:${var.aws_region}:${data.aws_caller_identity.current.account_id}:stateMachine:spawnpoint-delete-host" },
  ]
  # The log group the host's start commands write to; the same name as in infra/terraform/iam.tf and the workflows.
  session_command_log_group     = "/spawnpoint/session-commands"
  session_command_log_group_arn = "arn:aws:logs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:log-group:${local.session_command_log_group}"
  # The machines whose executions show an operation's steps, nested ones included.
  operation_progress_machines = concat(
    [for machine in local.operation_state_machines : machine.arn if contains(["start", "stop", "promote", "world"], machine.type)],
    [local.start_host_state_machine_arn, local.stop_host_state_machine_arn],
  )
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

data "archive_file" "control_plane_subscriptions" {
  type        = "zip"
  source_dir  = "${path.module}/../../lambdas/dist/control-plane-subscriptions"
  output_path = "${path.module}/../../lambdas/dist/control-plane-subscriptions.zip"
}

data "archive_file" "world_lifecycle" {
  type        = "zip"
  source_dir  = "${path.module}/../../lambdas/dist/world-lifecycle"
  output_path = "${path.module}/../../lambdas/dist/world-lifecycle.zip"
}
