# ADR-0102, step 7: one Spot interruption on demand, for a test world. FIS may
# reach only a launched host that carries both the fleet's tag and the arming
# tag scripts/spot-fault-test.sh puts on the one host it was asked about. The
# experiment stops when the interruption Lambda fails. Nothing exists unless
# both switches are on.

locals {
  spot_fault_test_count = var.spot == "enabled" && var.spot_fault_test == "enabled" ? 1 : 0
  spot_fault_target_tag = "SpawnpointFaultTarget"
}

data "aws_iam_policy_document" "spot_fault_test_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["fis.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "spot_fault_test" {
  count              = local.spot_fault_test_count
  name               = "spawnpoint-spot-fault-test"
  assume_role_policy = data.aws_iam_policy_document.spot_fault_test_assume.json
}

data "aws_iam_policy_document" "spot_fault_test" {
  statement {
    sid       = "FindTheArmedHost"
    actions   = ["ec2:DescribeInstances"]
    resources = ["*"]
  }

  statement {
    sid       = "InterruptOnlyTheArmedFleetHost"
    actions   = ["ec2:SendSpotInstanceInterruptions"]
    resources = ["arn:aws:ec2:${var.aws_region}:${local.account_id}:instance/*"]

    condition {
      test     = "StringEquals"
      variable = "ec2:ResourceTag/ManagedBy"
      values   = ["spawnpoint-fleet"]
    }

    condition {
      test     = "StringEquals"
      variable = "ec2:ResourceTag/${local.spot_fault_target_tag}"
      values   = ["armed"]
    }
  }
}

resource "aws_iam_role_policy" "spot_fault_test" {
  count  = local.spot_fault_test_count
  name   = "spawnpoint-spot-fault-test"
  role   = aws_iam_role.spot_fault_test[0].id
  policy = data.aws_iam_policy_document.spot_fault_test.json
}

resource "aws_fis_experiment_template" "spot_interruption" {
  count       = local.spot_fault_test_count
  description = "ADR-0102 step 7: a two-minute Spot interruption notice to the one armed fleet host."
  role_arn    = aws_iam_role.spot_fault_test[0].arn

  action {
    name      = "interrupt"
    action_id = "aws:ec2:send-spot-instance-interruptions"

    parameter {
      key   = "durationBeforeInterruption"
      value = "PT2M"
    }

    target {
      key   = "SpotInstances"
      value = "armed-host"
    }
  }

  target {
    name           = "armed-host"
    resource_type  = "aws:ec2:spot-instance"
    selection_mode = "COUNT(1)"

    resource_tag {
      key   = "ManagedBy"
      value = "spawnpoint-fleet"
    }

    resource_tag {
      key   = local.spot_fault_target_tag
      value = "armed"
    }

    filter {
      path   = "State.Name"
      values = ["running"]
    }
  }

  stop_condition {
    source = "aws:cloudwatch:alarm"
    value  = aws_cloudwatch_metric_alarm.spot_interruption_failed[0].arn
  }

  tags = {
    Name = "spawnpoint-spot-interruption"
  }
}
