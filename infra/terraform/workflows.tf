data "aws_iam_policy_document" "step_functions_assume_role" {
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
      values   = [data.aws_caller_identity.current.account_id]
    }

    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = ["arn:aws:states:${var.aws_region}:${data.aws_caller_identity.current.account_id}:stateMachine:spawnpoint-*"]
    }
  }
}

resource "aws_iam_role" "start_workflow" {
  name               = "spawnpoint-start-workflow"
  assume_role_policy = data.aws_iam_policy_document.step_functions_assume_role.json

  tags = {
    Name = "spawnpoint-start-workflow"
  }
}

data "aws_iam_policy_document" "start_workflow" {
  statement {
    sid = "ReadHostState"

    actions = [
      "ec2:DescribeInstances",
      "ssm:DescribeInstanceInformation",
      "ssm:GetCommandInvocation",
    ]
    resources = ["*"]
  }

  statement {
    sid       = "StartOnlySpawnpointHost"
    actions   = ["ec2:StartInstances"]
    resources = [aws_instance.game_host.arn]
  }

  statement {
    sid     = "RunOnlyApprovedDocumentOnSpawnpointHost"
    actions = ["ssm:SendCommand"]
    resources = [
      aws_instance.game_host.arn,
      "arn:aws:ssm:${var.aws_region}::document/AWS-RunShellScript",
    ]
  }
}

resource "aws_iam_role_policy" "start_workflow" {
  name   = "spawnpoint-start-workflow"
  role   = aws_iam_role.start_workflow.id
  policy = data.aws_iam_policy_document.start_workflow.json
}

resource "aws_sfn_state_machine" "start_server" {
  name       = "spawnpoint-start-server"
  role_arn   = aws_iam_role.start_workflow.arn
  type       = "STANDARD"
  definition = file("${path.module}/../../workflows/start-server.asl.json")

  tags = {
    Name    = "spawnpoint-start-server"
    Purpose = "on-demand-session-start"
  }
}

resource "aws_iam_role" "stop_workflow" {
  name               = "spawnpoint-stop-workflow"
  assume_role_policy = data.aws_iam_policy_document.step_functions_assume_role.json

  tags = {
    Name = "spawnpoint-stop-workflow"
  }
}

data "aws_iam_policy_document" "stop_workflow" {
  statement {
    sid = "ReadHostState"

    actions = [
      "ec2:DescribeInstances",
      "ssm:DescribeInstanceInformation",
      "ssm:GetCommandInvocation",
    ]
    resources = ["*"]
  }

  statement {
    sid       = "StopOnlySpawnpointHost"
    actions   = ["ec2:StopInstances"]
    resources = [aws_instance.game_host.arn]
  }

  statement {
    sid     = "RunOnlyApprovedDocumentOnSpawnpointHost"
    actions = ["ssm:SendCommand"]
    resources = [
      aws_instance.game_host.arn,
      "arn:aws:ssm:${var.aws_region}::document/AWS-RunShellScript",
    ]
  }
}

resource "aws_iam_role_policy" "stop_workflow" {
  name   = "spawnpoint-stop-workflow"
  role   = aws_iam_role.stop_workflow.id
  policy = data.aws_iam_policy_document.stop_workflow.json
}

resource "aws_sfn_state_machine" "stop_server" {
  name       = "spawnpoint-stop-server"
  role_arn   = aws_iam_role.stop_workflow.arn
  type       = "STANDARD"
  definition = file("${path.module}/../../workflows/stop-server.asl.json")

  tags = {
    Name    = "spawnpoint-stop-server"
    Purpose = "verified-session-stop"
  }
}

resource "aws_iam_role" "idle_watchdog" {
  name               = "spawnpoint-idle-watchdog"
  assume_role_policy = data.aws_iam_policy_document.step_functions_assume_role.json

  tags = {
    Name = "spawnpoint-idle-watchdog"
  }
}

data "aws_iam_policy_document" "idle_watchdog" {
  statement {
    sid = "ReadHostState"

    actions = [
      "ec2:DescribeInstances",
      "ssm:GetCommandInvocation",
    ]
    resources = ["*"]
  }

  statement {
    sid     = "ProbeOnlySpawnpointHost"
    actions = ["ssm:SendCommand"]
    resources = [
      aws_instance.game_host.arn,
      "arn:aws:ssm:${var.aws_region}::document/AWS-RunShellScript",
    ]
  }

  statement {
    sid       = "StartOnlyVerifiedStop"
    actions   = ["states:StartExecution"]
    resources = [aws_sfn_state_machine.stop_server.arn]
  }

  # startExecution.sync needs to observe the nested stop execution, and Step
  # Functions delivers its completion through a service-managed EventBridge rule.
  statement {
    sid = "WatchNestedStopExecutions"

    actions = [
      "states:DescribeExecution",
      "states:StopExecution",
    ]
    resources = [
      "arn:aws:states:${var.aws_region}:${data.aws_caller_identity.current.account_id}:execution:spawnpoint-stop-server:*",
    ]
  }

  statement {
    sid = "ManagedRuleForSyncExecutions"

    actions = [
      "events:PutRule",
      "events:PutTargets",
      "events:DescribeRule",
    ]
    resources = [
      "arn:aws:events:${var.aws_region}:${data.aws_caller_identity.current.account_id}:rule/StepFunctionsGetEventsForStepFunctionsExecutionRule",
    ]
  }
}

resource "aws_iam_role_policy" "idle_watchdog" {
  name   = "spawnpoint-idle-watchdog"
  role   = aws_iam_role.idle_watchdog.id
  policy = data.aws_iam_policy_document.idle_watchdog.json
}

resource "aws_sfn_state_machine" "idle_watchdog" {
  name       = "spawnpoint-idle-watchdog"
  role_arn   = aws_iam_role.idle_watchdog.arn
  type       = "STANDARD"
  definition = file("${path.module}/../../workflows/idle-watchdog.asl.json")

  tags = {
    Name    = "spawnpoint-idle-watchdog"
    Purpose = "session-scoped-idle-stop"
  }
}

resource "aws_iam_role" "promote_workflow" {
  name               = "spawnpoint-promote-release"
  assume_role_policy = data.aws_iam_policy_document.step_functions_assume_role.json

  tags = {
    Name = "spawnpoint-promote-release"
  }
}

data "aws_iam_policy_document" "promote_workflow" {
  statement {
    sid       = "ReadHostState"
    actions   = ["ec2:DescribeInstances"]
    resources = ["*"]
  }

  # HeadObject on the manifest and GetObject on the pointer are both s3:GetObject.
  statement {
    sid     = "ReadReleaseStore"
    actions = ["s3:GetObject"]
    resources = [
      "${data.aws_s3_bucket.releases.arn}/releases/*",
      "${data.aws_s3_bucket.releases.arn}/worlds/*",
    ]
  }

  # Promotion and import are the only pointer writers; the host never is.
  statement {
    sid       = "WriteOnlyPointers"
    actions   = ["s3:PutObject"]
    resources = ["${data.aws_s3_bucket.releases.arn}/worlds/*"]
  }

  statement {
    sid     = "StartChildMachines"
    actions = ["states:StartExecution"]
    resources = [
      aws_sfn_state_machine.start_server.arn,
      aws_sfn_state_machine.stop_server.arn,
      aws_sfn_state_machine.idle_watchdog.arn,
    ]
  }

  statement {
    sid = "WatchChildExecutions"

    actions = [
      "states:DescribeExecution",
      "states:StopExecution",
    ]
    resources = [
      "arn:aws:states:${var.aws_region}:${data.aws_caller_identity.current.account_id}:execution:spawnpoint-start-server:*",
      "arn:aws:states:${var.aws_region}:${data.aws_caller_identity.current.account_id}:execution:spawnpoint-stop-server:*",
    ]
  }

  statement {
    sid = "ManagedRuleForSyncExecutions"

    actions = [
      "events:PutRule",
      "events:PutTargets",
      "events:DescribeRule",
    ]
    resources = [
      "arn:aws:events:${var.aws_region}:${data.aws_caller_identity.current.account_id}:rule/StepFunctionsGetEventsForStepFunctionsExecutionRule",
    ]
  }
}

resource "aws_iam_role_policy" "promote_workflow" {
  name   = "spawnpoint-promote-release"
  role   = aws_iam_role.promote_workflow.id
  policy = data.aws_iam_policy_document.promote_workflow.json
}

resource "aws_sfn_state_machine" "promote_release" {
  name       = "spawnpoint-promote-release"
  role_arn   = aws_iam_role.promote_workflow.arn
  type       = "STANDARD"
  definition = file("${path.module}/../../workflows/promote-release.asl.json")

  tags = {
    Name    = "spawnpoint-promote-release"
    Purpose = "release-promotion-with-rollback"
  }
}
