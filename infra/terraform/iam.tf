locals {
  # Kept beside the policy that may write to it; the same literal appears in
  # workflows/start-server.asl.json and workflows/stop-server.asl.json, and a
  # test in tests/core.tftest.hcl holds the three to each other.
  session_command_log_group = "/spawnpoint/session-commands"

  game_host_release_resources = [
    "${data.aws_s3_bucket.releases.arn}/releases/*",
    "${data.aws_s3_bucket.releases.arn}/objects/*",
    "${data.aws_s3_bucket.releases.arn}/worlds/*",
  ]
}

data "aws_iam_policy_document" "ec2_assume_role" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "game_host" {
  name               = "spawnpoint-game-host"
  assume_role_policy = data.aws_iam_policy_document.ec2_assume_role.json

  tags = {
    Name = "spawnpoint-game-host"
  }
}

resource "aws_iam_role_policy_attachment" "ssm_core" {
  role       = aws_iam_role.game_host.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

data "aws_iam_policy_document" "game_host_storage" {
  statement {
    sid = "ListStoragePrefixes"

    actions = ["s3:ListBucket"]
    resources = [
      data.aws_s3_bucket.backups.arn,
      data.aws_s3_bucket.releases.arn,
    ]
  }

  statement {
    sid = "WriteAndVerifyBackups"

    actions = [
      "s3:AbortMultipartUpload",
      "s3:GetObject",
      "s3:PutObject",
    ]
    resources = ["${data.aws_s3_bucket.backups.arn}/*"]
  }

  statement {
    sid       = "ReadReleases"
    actions   = ["s3:GetObject"]
    resources = local.game_host_release_resources
  }
}

resource "aws_iam_role_policy" "game_host_storage" {
  name   = "spawnpoint-game-host-storage"
  role   = aws_iam_role.game_host.id
  policy = data.aws_iam_policy_document.game_host_storage.json
}

# Where the output of a session command survives the host that produced it.
# SSM hands an API caller at most 24,000 characters and a failed start's
# evidence is the tail: the lines the host script prints about why the game
# died. A start that fails terminates its host, so a log kept only there is a
# log nobody reads. The name is also written into the machines' sendCommand
# states, which are plain JSON and cannot interpolate a Terraform value.
resource "aws_cloudwatch_log_group" "session_commands" {
  name              = local.session_command_log_group
  retention_in_days = 14

  tags = {
    Name = "spawnpoint-session-commands"
  }
}

data "aws_iam_policy_document" "game_host_session_logs" {
  statement {
    sid = "WriteOnlySessionCommandOutput"
    actions = [
      "logs:CreateLogGroup",
      "logs:CreateLogStream",
      "logs:DescribeLogStreams",
      "logs:PutLogEvents",
    ]
    # Composed rather than read off the group: the policy is then known at
    # plan time, which is what lets tests/core.tftest.hcl assert on it.
    resources = ["arn:aws:logs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:log-group:${local.session_command_log_group}:*"]
  }

  # DescribeLogGroups admits no resource: scoped to a group ARN the statement
  # can never match, which is how the first attempt at this policy allowed
  # every write and still delivered nothing. The SSM agent looks the group up
  # before it writes, and that lookup is account-wide by construction.
  statement {
    sid       = "FindTheGroupBeforeWriting"
    actions   = ["logs:DescribeLogGroups"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "game_host_session_logs" {
  name   = "spawnpoint-game-host-session-logs"
  role   = aws_iam_role.game_host.id
  policy = data.aws_iam_policy_document.game_host_session_logs.json
}

# A Spot host reports that it saved its sessions for an interruption
# (ADR-0102) as one event on the default bus. Only its own source is allowed,
# so a host cannot speak for EC2 or for the control plane.
data "aws_iam_policy_document" "game_host_interruption_report" {
  statement {
    sid       = "ReportInterruptionSaves"
    actions   = ["events:PutEvents"]
    resources = ["arn:aws:events:${var.aws_region}:${data.aws_caller_identity.current.account_id}:event-bus/default"]

    condition {
      test     = "StringEquals"
      variable = "events:source"
      values   = ["spawnpoint.host"]
    }
  }
}

resource "aws_iam_role_policy" "game_host_interruption_report" {
  name   = "spawnpoint-game-host-interruption-report"
  role   = aws_iam_role.game_host.id
  policy = data.aws_iam_policy_document.game_host_interruption_report.json
}

resource "aws_iam_instance_profile" "game_host" {
  name = "spawnpoint-game-host"
  role = aws_iam_role.game_host.name
}
