data "aws_availability_zone" "selected" {
  name = var.availability_zone
}

data "aws_caller_identity" "current" {}

locals {
  backup_bucket_name              = "spawnpoint-backups-${data.aws_caller_identity.current.account_id}"
  release_bucket_name             = "spawnpoint-releases-${data.aws_caller_identity.current.account_id}"
  idle_watchdog_state_machine_arn = "arn:aws:states:${var.aws_region}:${data.aws_caller_identity.current.account_id}:stateMachine:spawnpoint-idle-watchdog"
  promote_state_machine_arn       = "arn:aws:states:${var.aws_region}:${data.aws_caller_identity.current.account_id}:stateMachine:spawnpoint-promote-release"
}

data "aws_s3_bucket" "backups" {
  bucket = local.backup_bucket_name
}

data "aws_s3_bucket" "releases" {
  bucket = local.release_bucket_name
}

data "aws_ssm_parameter" "amazon_linux_2023_ami" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64"
}
