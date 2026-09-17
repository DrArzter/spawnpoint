# The host's half of the two-level stop (ADR-0054). A session stop that
# empties a launched host starts one execution of this machine for it. The
# machine waits out the grace period, asks the coordinator what the fleet
# needs, and either lets the host go, stops it, or keeps waiting while it is
# the fleet's headroom. The configured host never reaches it: its drain
# decision is always to stop, and the V1 stop already does that.
locals {
  lifecycle_v2_drain_arn = "arn:aws:states:${var.aws_region}:${local.account_id}:stateMachine:spawnpoint-drain-host-v2"
}

data "aws_iam_policy_document" "lifecycle_v2_drain_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["states.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }

    condition {
      test     = "ArnEquals"
      variable = "aws:SourceArn"
      values   = [local.lifecycle_v2_drain_arn]
    }
  }
}

resource "aws_iam_role" "lifecycle_v2_drain" {
  name               = "spawnpoint-drain-host-v2"
  assume_role_policy = data.aws_iam_policy_document.lifecycle_v2_drain_assume.json

  tags = { Name = "spawnpoint-drain-host-v2" }
}

data "aws_iam_policy_document" "lifecycle_v2_drain" {
  statement {
    sid       = "CoordinateLifecycle"
    actions   = ["lambda:InvokeFunction"]
    resources = [local.lifecycle_v2_coordinator_arn]
  }

  # Only a host carrying the fleet tag can be stopped or let go by a drain;
  # the configured instance carries no such tag and keeps its termination
  # protection besides.
  statement {
    sid       = "StopOrTerminateOnlyLaunchedHosts"
    actions   = ["ec2:StopInstances", "ec2:TerminateInstances"]
    resources = ["arn:aws:ec2:${var.aws_region}:${local.account_id}:instance/*"]

    condition {
      test     = "StringEquals"
      variable = "ec2:ResourceTag/ManagedBy"
      values   = ["spawnpoint-fleet"]
    }
  }

  statement {
    sid       = "ObserveHosts"
    actions   = ["ec2:DescribeInstances"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "lifecycle_v2_drain" {
  name   = "spawnpoint-drain-host-v2"
  role   = aws_iam_role.lifecycle_v2_drain.id
  policy = data.aws_iam_policy_document.lifecycle_v2_drain.json
}

resource "aws_sfn_state_machine" "lifecycle_v2_drain" {
  name     = "spawnpoint-drain-host-v2"
  role_arn = aws_iam_role.lifecycle_v2_drain.arn
  type     = "STANDARD"
  definition = templatefile("${path.module}/../../workflows/drain-host-v2.asl.json.tftpl", {
    coordinator_function_arn = local.lifecycle_v2_coordinator_arn
    grace_period_seconds     = var.drain_grace_seconds
    headroom_mib             = var.headroom_mib
    max_keep_polls           = var.drain_max_keep_polls
  })

  tags = {
    Name    = "spawnpoint-drain-host-v2"
    Purpose = "host-drain-after-last-session"
  }
}
