locals {
  lifecycle_v2_coordinator_arn = "arn:aws:lambda:${var.aws_region}:${local.account_id}:function:spawnpoint-lifecycle-coordinator-v2"
  lifecycle_v2_start_arn       = "arn:aws:states:${var.aws_region}:${data.aws_caller_identity.current.account_id}:stateMachine:spawnpoint-start-server-v2"
  lifecycle_v2_stop_arn        = "arn:aws:states:${var.aws_region}:${data.aws_caller_identity.current.account_id}:stateMachine:spawnpoint-stop-server-v2"
  lifecycle_v2_watchdog_arn    = "arn:aws:states:${var.aws_region}:${data.aws_caller_identity.current.account_id}:stateMachine:spawnpoint-idle-watchdog-v2"

  lifecycle_v2_sync_events_arn = "arn:aws:events:${var.aws_region}:${data.aws_caller_identity.current.account_id}:rule/StepFunctionsGetEventsForStepFunctionsExecutionRule"
}

data "aws_iam_policy_document" "lifecycle_v2_start_assume" {
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
      test     = "ArnEquals"
      variable = "aws:SourceArn"
      values   = [local.lifecycle_v2_start_arn]
    }
  }
}

resource "aws_iam_role" "lifecycle_v2_start" {
  name               = "spawnpoint-start-server-v2"
  assume_role_policy = data.aws_iam_policy_document.lifecycle_v2_start_assume.json

  tags = { Name = "spawnpoint-start-server-v2" }
}

data "aws_iam_policy_document" "lifecycle_v2_start" {
  statement {
    sid       = "CoordinateLifecycle"
    actions   = ["lambda:InvokeFunction"]
    resources = [local.lifecycle_v2_coordinator_arn]
  }

  statement {
    sid       = "StartOnlyAcceptedHostOperations"
    actions   = ["states:StartExecution"]
    resources = [local.start_state_machine_arn, local.stop_state_machine_arn, local.lifecycle_v2_watchdog_arn]
  }

  statement {
    sid     = "WatchOnlyAcceptedHostOperations"
    actions = ["states:DescribeExecution", "states:StopExecution"]
    resources = [
      "arn:aws:states:${var.aws_region}:${data.aws_caller_identity.current.account_id}:execution:spawnpoint-start-server:*",
      "arn:aws:states:${var.aws_region}:${data.aws_caller_identity.current.account_id}:execution:spawnpoint-stop-server:*",
    ]
  }

  statement {
    sid       = "ManagedRuleForSyncExecutions"
    actions   = ["events:PutRule", "events:PutTargets", "events:DescribeRule"]
    resources = [local.lifecycle_v2_sync_events_arn]
  }

  statement {
    sid       = "ForceStopOnlyFailedStartHost"
    actions   = ["ec2:StopInstances"]
    resources = [data.aws_instance.game_host.arn]
  }

  statement {
    sid       = "ObserveForcedStop"
    actions   = ["ec2:DescribeInstances"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "lifecycle_v2_start" {
  name   = "spawnpoint-start-server-v2"
  role   = aws_iam_role.lifecycle_v2_start.id
  policy = data.aws_iam_policy_document.lifecycle_v2_start.json
}

resource "aws_sfn_state_machine" "lifecycle_v2_start" {
  name     = "spawnpoint-start-server-v2"
  role_arn = aws_iam_role.lifecycle_v2_start.arn
  type     = "STANDARD"
  definition = templatefile("${path.module}/../../workflows/start-server-v2.asl.json.tftpl", {
    coordinator_function_arn   = local.lifecycle_v2_coordinator_arn
    start_v1_state_machine_arn = local.start_state_machine_arn
    stop_v1_state_machine_arn  = local.stop_state_machine_arn
    watchdog_state_machine_arn = local.lifecycle_v2_watchdog_arn
  })

  tags = {
    Name    = "spawnpoint-start-server-v2"
    Purpose = "fenced-session-start"
  }
}

data "aws_iam_policy_document" "lifecycle_v2_stop_assume" {
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
      test     = "ArnEquals"
      variable = "aws:SourceArn"
      values   = [local.lifecycle_v2_stop_arn]
    }
  }
}

resource "aws_iam_role" "lifecycle_v2_stop" {
  name               = "spawnpoint-stop-server-v2"
  assume_role_policy = data.aws_iam_policy_document.lifecycle_v2_stop_assume.json

  tags = { Name = "spawnpoint-stop-server-v2" }
}

data "aws_iam_policy_document" "lifecycle_v2_stop" {
  statement {
    sid       = "CoordinateLifecycle"
    actions   = ["lambda:InvokeFunction"]
    resources = [local.lifecycle_v2_coordinator_arn]
  }

  statement {
    sid       = "StartOnlyAcceptedVerifiedStop"
    actions   = ["states:StartExecution"]
    resources = [local.stop_state_machine_arn]
  }

  statement {
    sid     = "WatchOnlyAcceptedVerifiedStop"
    actions = ["states:DescribeExecution", "states:StopExecution"]
    resources = [
      "arn:aws:states:${var.aws_region}:${data.aws_caller_identity.current.account_id}:execution:spawnpoint-stop-server:*",
    ]
  }

  statement {
    sid       = "ManagedRuleForSyncExecutions"
    actions   = ["events:PutRule", "events:PutTargets", "events:DescribeRule"]
    resources = [local.lifecycle_v2_sync_events_arn]
  }
}

resource "aws_iam_role_policy" "lifecycle_v2_stop" {
  name   = "spawnpoint-stop-server-v2"
  role   = aws_iam_role.lifecycle_v2_stop.id
  policy = data.aws_iam_policy_document.lifecycle_v2_stop.json
}

resource "aws_sfn_state_machine" "lifecycle_v2_stop" {
  name     = "spawnpoint-stop-server-v2"
  role_arn = aws_iam_role.lifecycle_v2_stop.arn
  type     = "STANDARD"
  definition = templatefile("${path.module}/../../workflows/stop-server-v2.asl.json.tftpl", {
    coordinator_function_arn  = local.lifecycle_v2_coordinator_arn
    stop_v1_state_machine_arn = local.stop_state_machine_arn
  })

  tags = {
    Name    = "spawnpoint-stop-server-v2"
    Purpose = "fenced-session-stop"
  }
}

data "aws_iam_policy_document" "lifecycle_v2_watchdog_assume" {
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
      test     = "ArnEquals"
      variable = "aws:SourceArn"
      values   = [local.lifecycle_v2_watchdog_arn]
    }
  }
}

resource "aws_iam_role" "lifecycle_v2_watchdog" {
  name               = "spawnpoint-idle-watchdog-v2"
  assume_role_policy = data.aws_iam_policy_document.lifecycle_v2_watchdog_assume.json

  tags = { Name = "spawnpoint-idle-watchdog-v2" }
}

data "aws_iam_policy_document" "lifecycle_v2_watchdog" {
  statement {
    sid       = "CoordinateLifecycle"
    actions   = ["lambda:InvokeFunction"]
    resources = [local.lifecycle_v2_coordinator_arn]
  }

  statement {
    sid       = "ReadHostState"
    actions   = ["ec2:DescribeInstances", "ssm:GetCommandInvocation"]
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
    sid       = "StartOnlyFencedStop"
    actions   = ["states:StartExecution"]
    resources = [local.lifecycle_v2_stop_arn]
  }

  statement {
    sid     = "WatchOnlyFencedStop"
    actions = ["states:DescribeExecution", "states:StopExecution"]
    resources = [
      "arn:aws:states:${var.aws_region}:${data.aws_caller_identity.current.account_id}:execution:spawnpoint-stop-server-v2:*",
    ]
  }

  statement {
    sid       = "ManagedRuleForSyncExecutions"
    actions   = ["events:PutRule", "events:PutTargets", "events:DescribeRule"]
    resources = [local.lifecycle_v2_sync_events_arn]
  }
}

resource "aws_iam_role_policy" "lifecycle_v2_watchdog" {
  name   = "spawnpoint-idle-watchdog-v2"
  role   = aws_iam_role.lifecycle_v2_watchdog.id
  policy = data.aws_iam_policy_document.lifecycle_v2_watchdog.json
}

resource "aws_sfn_state_machine" "lifecycle_v2_watchdog" {
  name     = "spawnpoint-idle-watchdog-v2"
  role_arn = aws_iam_role.lifecycle_v2_watchdog.arn
  type     = "STANDARD"
  definition = templatefile("${path.module}/../../workflows/idle-watchdog-v2.asl.json.tftpl", {
    coordinator_function_arn  = local.lifecycle_v2_coordinator_arn
    stop_v2_state_machine_arn = local.lifecycle_v2_stop_arn
  })

  tags = {
    Name    = "spawnpoint-idle-watchdog-v2"
    Purpose = "session-scoped-idle-stop"
  }
}
