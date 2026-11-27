# Deleting a persistent host from the panel (ADR-0100). The API checks that no
# world is placed on the host and that it is stopped, then starts one execution;
# the execution is the operation record. The grants reach only the instance and
# the volumes Spawnpoint named, whatever id the request carries.
locals {
  delete_host_arn = "arn:aws:states:${var.aws_region}:${local.account_id}:stateMachine:spawnpoint-delete-host"
}

data "aws_iam_policy_document" "delete_host_assume" {
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
      values   = [local.delete_host_arn]
    }
  }
}

resource "aws_iam_role" "delete_host" {
  name               = "spawnpoint-delete-host"
  assume_role_policy = data.aws_iam_policy_document.delete_host_assume.json

  tags = { Name = "spawnpoint-delete-host" }
}

data "aws_iam_policy_document" "delete_host" {
  # The record of its own run, and of its parent and root (ADR-0105); only record keys.
  statement {
    sid       = "WriteOperationRecords"
    actions   = ["dynamodb:UpdateItem"]
    resources = [local.control_plane_view_table_arn]

    condition {
      test     = "ForAllValues:StringLike"
      variable = "dynamodb:LeadingKeys"
      values   = ["OPERATION#*"]
    }
  }

  statement {
    sid       = "ObserveHostsVolumesAndSnapshots"
    actions   = ["ec2:DescribeInstances", "ec2:DescribeSnapshots", "cloudwatch:DescribeAlarmsForMetric"]
    resources = ["*"]
  }

  statement {
    sid       = "UnprotectAndTerminateOnlyThePersistentHost"
    actions   = ["ec2:ModifyInstanceAttribute", "ec2:TerminateInstances"]
    resources = ["arn:aws:ec2:${var.aws_region}:${local.account_id}:instance/*"]

    condition {
      test     = "StringEquals"
      variable = "ec2:ResourceTag/Name"
      values   = [local.persistent_host_name]
    }
  }

  statement {
    sid       = "SnapshotAndDeleteOnlyItsDataVolume"
    actions   = ["ec2:CreateSnapshot", "ec2:DeleteVolume"]
    resources = ["arn:aws:ec2:${var.aws_region}:${local.account_id}:volume/*"]

    condition {
      test     = "StringEquals"
      variable = "ec2:ResourceTag/Name"
      values   = ["spawnpoint-data"]
    }
  }

  statement {
    sid       = "CreateTheSnapshot"
    actions   = ["ec2:CreateSnapshot"]
    resources = ["arn:aws:ec2:${var.aws_region}::snapshot/*"]
  }

  statement {
    sid       = "TagTheSnapshotAsItIsMade"
    actions   = ["ec2:CreateTags"]
    resources = ["arn:aws:ec2:${var.aws_region}::snapshot/*"]

    condition {
      test     = "StringEquals"
      variable = "ec2:CreateAction"
      values   = ["CreateSnapshot"]
    }
  }

  statement {
    sid       = "DeleteOnlySpawnpointAlarms"
    actions   = ["cloudwatch:DeleteAlarms"]
    resources = ["arn:aws:cloudwatch:${var.aws_region}:${local.account_id}:alarm:spawnpoint-*"]
  }
}

resource "aws_iam_role_policy" "delete_host" {
  name   = "spawnpoint-delete-host"
  role   = aws_iam_role.delete_host.id
  policy = data.aws_iam_policy_document.delete_host.json
}

resource "aws_sfn_state_machine" "delete_host" {
  name       = "spawnpoint-delete-host"
  role_arn   = aws_iam_role.delete_host.arn
  type       = "STANDARD"
  definition = templatefile("${path.module}/../../workflows/delete-host.asl.json.tftpl", { operation_table_name = var.control_plane_view_table_name })

  tags = {
    Name    = "spawnpoint-delete-host"
    Purpose = "persistent-host-deletion"
  }
}
