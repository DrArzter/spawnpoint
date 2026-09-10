data "aws_iam_policy_document" "idle_watchdog_assume_role" {
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
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = [local.idle_watchdog_state_machine_arn]
    }
  }
}

resource "aws_iam_role" "idle_watchdog" {
  name               = "spawnpoint-idle-watchdog"
  assume_role_policy = data.aws_iam_policy_document.idle_watchdog_assume_role.json

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
      data.aws_instance.game_host.arn,
      "arn:aws:ssm:${var.aws_region}::document/AWS-RunShellScript",
    ]
  }

  statement {
    sid       = "StartOnlyVerifiedStop"
    actions   = ["states:StartExecution"]
    resources = [local.stop_state_machine_arn]
  }

  statement {
    sid = "WatchNestedStopExecutions"

    actions = [
      "states:DescribeExecution",
      "states:StopExecution",
    ]
    resources = [
      "arn:aws:states:${var.aws_region}:${local.account_id}:execution:spawnpoint-stop-server:*",
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
      "arn:aws:events:${var.aws_region}:${local.account_id}:rule/StepFunctionsGetEventsForStepFunctionsExecutionRule",
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

data "aws_iam_policy_document" "promote_workflow_assume_role" {
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
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = ["arn:aws:states:${var.aws_region}:${local.account_id}:stateMachine:spawnpoint-promote-release"]
    }
  }
}

resource "aws_iam_role" "promote_workflow" {
  name               = "spawnpoint-promote-release"
  assume_role_policy = data.aws_iam_policy_document.promote_workflow_assume_role.json

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

  statement {
    sid       = "VerifyPublishedRelease"
    actions   = ["s3:GetObject"]
    resources = ["${data.aws_s3_bucket.releases.arn}/releases/*"]
  }

  statement {
    sid       = "MutateReleaseState"
    actions   = ["lambda:InvokeFunction"]
    resources = [aws_lambda_function.release_state.arn]
  }

  statement {
    sid     = "StartChildMachines"
    actions = ["states:StartExecution"]
    resources = [
      local.start_state_machine_arn,
      local.stop_state_machine_arn,
      local.idle_watchdog_state_machine_arn,
    ]
  }

  statement {
    sid = "WatchChildExecutions"

    actions = [
      "states:DescribeExecution",
      "states:StopExecution",
    ]
    resources = [
      "arn:aws:states:${var.aws_region}:${local.account_id}:execution:spawnpoint-start-server:*",
      "arn:aws:states:${var.aws_region}:${local.account_id}:execution:spawnpoint-stop-server:*",
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
      "arn:aws:events:${var.aws_region}:${local.account_id}:rule/StepFunctionsGetEventsForStepFunctionsExecutionRule",
    ]
  }
}

resource "aws_iam_role_policy" "promote_workflow" {
  name   = "spawnpoint-promote-release"
  role   = aws_iam_role.promote_workflow.id
  policy = data.aws_iam_policy_document.promote_workflow.json
}

resource "aws_sfn_state_machine" "promote_release" {
  name     = "spawnpoint-promote-release"
  role_arn = aws_iam_role.promote_workflow.arn
  type     = "STANDARD"
  definition = templatefile("${path.module}/../../workflows/promote-release.asl.json", {
    release_state_function_arn = local.release_state_function_arn
  })

  tags = {
    Name    = "spawnpoint-promote-release"
    Purpose = "release-promotion-with-rollback"
  }
}
