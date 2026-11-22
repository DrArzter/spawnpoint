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

  # A start that reached ready records the release it proved, which is what
  # the active pointer means. Promotion does the same through the same
  # function; this grant is the start's half of it.
  statement {
    sid       = "RecordProvenRelease"
    actions   = ["lambda:InvokeFunction"]
    resources = [local.release_state_function_arn]
  }

  statement {
    sid       = "StartOnlyAcceptedHostOperations"
    actions   = ["states:StartExecution"]
    resources = [local.start_state_machine_arn, local.stop_state_machine_arn, local.lifecycle_v2_watchdog_arn]
  }

  statement {
    sid       = "DrainFailedLaunchedStart"
    actions   = ["states:StartExecution"]
    resources = [local.lifecycle_v2_drain_arn]
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
    sid       = "ForceStopOnlyFailedLaunchedHost"
    actions   = ["ec2:StopInstances"]
    resources = ["arn:aws:ec2:${var.aws_region}:${data.aws_caller_identity.current.account_id}:instance/*"]

    condition {
      test     = "StringEquals"
      variable = "ec2:ResourceTag/ManagedBy"
      values   = ["spawnpoint-fleet"]
    }
  }

  statement {
    sid       = "ObserveForcedStop"
    actions   = ["ec2:DescribeInstances"]
    resources = ["*"]
  }

  # The host record (ADR-0054) carries what the host turned out to be, read
  # from the instance type after the session is up.
  statement {
    sid       = "DescribeHostShape"
    actions   = ["ec2:DescribeInstanceTypes"]
    resources = ["*"]
  }

  # Launching a host for a session (ADR-0054, phase 12): an instant Fleet from
  # the fleet template, tagged so every later statement recognises it.
  statement {
    sid       = "LaunchFleetHosts"
    actions   = ["ec2:CreateFleet", "ec2:RunInstances"]
    resources = ["*"]
  }

  statement {
    sid       = "TagWhatItLaunches"
    actions   = ["ec2:CreateTags"]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "ec2:CreateAction"
      values   = ["RunInstances", "CreateFleet"]
    }
  }

  statement {
    sid       = "PassOnlyTheHostRole"
    actions   = ["iam:PassRole"]
    resources = ["arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/spawnpoint-game-host"]

    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["ec2.amazonaws.com"]
    }
  }

  # A host launched for a session that could not be reserved is let go at
  # once, and only a host carrying the fleet tag can be.
  statement {
    sid       = "TerminateOnlyLaunchedHosts"
    actions   = ["ec2:TerminateInstances"]
    resources = ["arn:aws:ec2:${var.aws_region}:${data.aws_caller_identity.current.account_id}:instance/*"]

    condition {
      test     = "StringEquals"
      variable = "ec2:ResourceTag/ManagedBy"
      values   = ["spawnpoint-fleet"]
    }
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
    release_state_function_arn = local.release_state_function_arn
    start_v1_state_machine_arn = local.start_state_machine_arn
    stop_v1_state_machine_arn  = local.stop_state_machine_arn
    watchdog_state_machine_arn = local.lifecycle_v2_watchdog_arn
    drain_state_machine_arn    = local.lifecycle_v2_drain_arn
    fleet_launch_template_name = "spawnpoint-fleet-host"
    allowed_instance_types     = jsonencode(var.launch_families)
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

  # The stop that empties a launched host starts its drain (ADR-0054).
  statement {
    sid       = "StartDrainOfEmptiedHost"
    actions   = ["states:StartExecution"]
    resources = [local.lifecycle_v2_drain_arn]
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
    drain_state_machine_arn   = local.lifecycle_v2_drain_arn
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

  # A session placed on a launched host is probed on that host, which does not
  # exist when this policy is written. Without this the watchdog is denied at
  # its first probe, goes blind after the consecutive-failure budget and dies —
  # and a fleet session then has nothing to stop it but the running-hours
  # alarm. The start and stop machines reach the same hosts the same way.
  statement {
    sid       = "ProbeLaunchedHosts"
    actions   = ["ssm:SendCommand"]
    resources = ["arn:aws:ec2:${var.aws_region}:${data.aws_caller_identity.current.account_id}:instance/*"]

    condition {
      test     = "StringEquals"
      variable = "ssm:resourceTag/ManagedBy"
      values   = ["spawnpoint-fleet"]
    }
  }

  # EC2 has no memory metric. The probe reads memory on the host and the watchdog
  # publishes it (ADR-0015). PutMetricData takes no resource, so the namespace
  # condition is the whole limit: the watchdog cannot write any other metric.
  statement {
    sid       = "PublishHostMemory"
    actions   = ["cloudwatch:PutMetricData"]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "cloudwatch:namespace"
      values   = ["Spawnpoint/Host"]
    }
  }

  statement {
    sid       = "StartOnlyFencedStop"
    actions   = ["states:StartExecution"]
    resources = [local.lifecycle_v2_stop_arn]
  }

  # At its check cap with players still online the stop is refused, and the
  # session needs watching by somebody. This watchdog has spent its budget, so
  # it starts its successor and ends.
  statement {
    sid       = "HandOverToAFreshWatchdog"
    actions   = ["states:StartExecution"]
    resources = [local.lifecycle_v2_watchdog_arn]
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
    coordinator_function_arn   = local.lifecycle_v2_coordinator_arn
    stop_v2_state_machine_arn  = local.lifecycle_v2_stop_arn
    watchdog_state_machine_arn = local.lifecycle_v2_watchdog_arn
  })

  tags = {
    Name    = "spawnpoint-idle-watchdog-v2"
    Purpose = "session-scoped-idle-stop"
  }
}
