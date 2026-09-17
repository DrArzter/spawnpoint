data "aws_caller_identity" "current" {}

locals {
  account_id                      = data.aws_caller_identity.current.account_id
  release_bucket_name             = "spawnpoint-releases-${local.account_id}"
  start_state_machine_arn         = "arn:aws:states:${var.aws_region}:${local.account_id}:stateMachine:spawnpoint-start-server"
  stop_state_machine_arn          = "arn:aws:states:${var.aws_region}:${local.account_id}:stateMachine:spawnpoint-stop-server"
  idle_watchdog_state_machine_arn = "arn:aws:states:${var.aws_region}:${local.account_id}:stateMachine:spawnpoint-idle-watchdog"
  release_state_function_arn      = "arn:aws:lambda:${var.aws_region}:${local.account_id}:function:spawnpoint-release-state"
}

data "aws_s3_bucket" "releases" {
  bucket = local.release_bucket_name
}

data "aws_dynamodb_table" "lifecycle" {
  name = "spawnpoint-lifecycle-v2"
}

# The template a start launches a host from (core root, fleet.tf), by its
# stable name: the operations root never owns compute.
data "aws_launch_template" "fleet_host" {
  name = "spawnpoint-fleet-host"
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
