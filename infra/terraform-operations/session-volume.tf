# ADR-0102: a session volume carries one tag that marks it as Spawnpoint's and
# one that names its session. Every IAM grant on a volume and the workflows
# that create and find it use these values.
locals {
  session_volume_managed_by   = "spawnpoint-session-volume"
  session_volume_session_tag  = "SessionId"
  session_volume_unmount_doc  = "arn:aws:ssm:${var.aws_region}:${local.account_id}:document/spawnpoint-unmount-session-volume"
  session_volume_arn_pattern  = "arn:aws:ec2:${var.aws_region}:${local.account_id}:volume/*"
  session_volume_host_pattern = "arn:aws:ec2:${var.aws_region}:${local.account_id}:instance/*"
  session_volume_template_vars = {
    session_volume             = var.session_volume
    session_volume_size_gib    = var.session_volume_size_gib
    session_volume_managed_by  = local.session_volume_managed_by
    session_volume_session_tag = local.session_volume_session_tag
  }
}

# The release after a verified archive: unmount on a host that keeps running,
# detach, delete. The start's compensation and the stop both run it.
data "aws_iam_policy_document" "session_volume_release" {
  statement {
    sid       = "FindSessionVolumes"
    actions   = ["ec2:DescribeVolumes"]
    resources = ["*"]
  }

  statement {
    sid       = "DetachSessionVolumes"
    actions   = ["ec2:DetachVolume"]
    resources = [local.session_volume_arn_pattern]

    condition {
      test     = "StringEquals"
      variable = "ec2:ResourceTag/ManagedBy"
      values   = [local.session_volume_managed_by]
    }
  }

  statement {
    sid       = "DetachFromLaunchedHosts"
    actions   = ["ec2:DetachVolume"]
    resources = [local.session_volume_host_pattern]

    condition {
      test     = "StringEquals"
      variable = "ec2:ResourceTag/ManagedBy"
      values   = ["spawnpoint-fleet"]
    }
  }

  statement {
    sid       = "DeleteSessionVolumes"
    actions   = ["ec2:DeleteVolume"]
    resources = [local.session_volume_arn_pattern]

    condition {
      test     = "StringEquals"
      variable = "ec2:ResourceTag/ManagedBy"
      values   = [local.session_volume_managed_by]
    }
  }

  statement {
    sid       = "UnmountThroughItsDocument"
    actions   = ["ssm:SendCommand"]
    resources = [local.session_volume_unmount_doc]
  }

  statement {
    sid       = "UnmountOnLaunchedHosts"
    actions   = ["ssm:SendCommand"]
    resources = [local.session_volume_host_pattern]

    condition {
      test     = "StringEquals"
      variable = "ssm:resourceTag/ManagedBy"
      values   = ["spawnpoint-fleet"]
    }
  }

  statement {
    sid       = "ReadUnmountResult"
    actions   = ["ssm:GetCommandInvocation"]
    resources = ["*"]
  }
}

# The start creates the volume tagged, and attaches it only to a launched host.
data "aws_iam_policy_document" "session_volume_create" {
  statement {
    sid       = "CreateTaggedSessionVolumes"
    actions   = ["ec2:CreateVolume"]
    resources = [local.session_volume_arn_pattern]

    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/ManagedBy"
      values   = [local.session_volume_managed_by]
    }
  }

  statement {
    sid       = "TagSessionVolumesAtCreation"
    actions   = ["ec2:CreateTags"]
    resources = [local.session_volume_arn_pattern]

    condition {
      test     = "StringEquals"
      variable = "ec2:CreateAction"
      values   = ["CreateVolume"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/ManagedBy"
      values   = [local.session_volume_managed_by]
    }
  }

  statement {
    sid       = "AttachSessionVolumes"
    actions   = ["ec2:AttachVolume"]
    resources = [local.session_volume_arn_pattern]

    condition {
      test     = "StringEquals"
      variable = "ec2:ResourceTag/ManagedBy"
      values   = [local.session_volume_managed_by]
    }
  }

  statement {
    sid       = "AttachToLaunchedHosts"
    actions   = ["ec2:AttachVolume"]
    resources = [local.session_volume_host_pattern]

    condition {
      test     = "StringEquals"
      variable = "ec2:ResourceTag/ManagedBy"
      values   = ["spawnpoint-fleet"]
    }
  }
}

resource "aws_iam_role_policy" "lifecycle_v2_start_session_volume" {
  name   = "spawnpoint-start-server-v2-session-volume"
  role   = aws_iam_role.lifecycle_v2_start.id
  policy = data.aws_iam_policy_document.lifecycle_v2_start_session_volume.json
}

data "aws_iam_policy_document" "lifecycle_v2_start_session_volume" {
  source_policy_documents = [
    data.aws_iam_policy_document.session_volume_create.json,
    data.aws_iam_policy_document.session_volume_release.json,
  ]
}

resource "aws_iam_role_policy" "lifecycle_v2_stop_session_volume" {
  name   = "spawnpoint-stop-server-v2-session-volume"
  role   = aws_iam_role.lifecycle_v2_stop.id
  policy = data.aws_iam_policy_document.session_volume_release.json
}
