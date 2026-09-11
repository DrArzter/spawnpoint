data "aws_caller_identity" "current" {}

locals {
  account_id                      = data.aws_caller_identity.current.account_id
  release_bucket_name             = "spawnpoint-releases-${local.account_id}"
  start_state_machine_arn         = "arn:aws:states:${var.aws_region}:${local.account_id}:stateMachine:spawnpoint-start-server-v2"
  stop_state_machine_arn          = "arn:aws:states:${var.aws_region}:${local.account_id}:stateMachine:spawnpoint-stop-server-v2"
  idle_watchdog_state_machine_arn = "arn:aws:states:${var.aws_region}:${local.account_id}:stateMachine:spawnpoint-idle-watchdog-v2"
}

data "aws_s3_bucket" "releases" {
  bucket = local.release_bucket_name
}

data "aws_dynamodb_table" "access" {
  name = "spawnpoint-access"
}

data "aws_instance" "game_host" {
  filter {
    name   = "tag:Name"
    values = ["spawnpoint-game-host"]
  }

  filter {
    name   = "instance-state-name"
    values = ["pending", "running", "stopping", "stopped"]
  }
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
