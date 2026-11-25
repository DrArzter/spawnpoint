data "aws_caller_identity" "current" {}

locals {
  account_id                 = data.aws_caller_identity.current.account_id
  release_bucket_name        = "spawnpoint-releases-${local.account_id}"
  start_state_machine_arn    = "arn:aws:states:${var.aws_region}:${local.account_id}:stateMachine:spawnpoint-start-server"
  stop_state_machine_arn     = "arn:aws:states:${var.aws_region}:${local.account_id}:stateMachine:spawnpoint-stop-server"
  release_state_function_arn = "arn:aws:lambda:${var.aws_region}:${local.account_id}:function:spawnpoint-release-state"
}

data "aws_s3_bucket" "releases" {
  bucket = local.release_bucket_name
}

data "aws_dynamodb_table" "lifecycle" {
  name = "spawnpoint-lifecycle-v2"
}

# The persistent host, if one still exists (ADR-0100): the panel may have
# deleted it, so this lists rather than requires one.
data "aws_instances" "persistent_host" {
  filter {
    name   = "tag:Name"
    values = ["spawnpoint-game-host"]
  }

  instance_state_names = ["pending", "running", "stopping", "stopped"]
}

locals {
  persistent_host_name = "spawnpoint-game-host"
  # An event pattern needs at least one value. With no persistent host left the
  # rules match an id no instance has, and stay in place rather than be deleted.
  persistent_host_event_ids = length(data.aws_instances.persistent_host.ids) > 0 ? data.aws_instances.persistent_host.ids : ["i-00000000000000000"]
}
