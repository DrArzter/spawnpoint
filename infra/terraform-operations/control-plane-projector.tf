locals {
  control_plane_projector_arn     = "arn:aws:lambda:${var.aws_region}:${local.account_id}:function:spawnpoint-control-plane-projector"
  control_plane_reconcile_arn     = "arn:aws:states:${var.aws_region}:${local.account_id}:stateMachine:spawnpoint-control-plane-reconcile-stopped"
  control_plane_stopped_rule_arn  = "arn:aws:events:${var.aws_region}:${local.account_id}:rule/spawnpoint-control-plane-stopped-reconcile"
  control_plane_terminal_rule_arn = "arn:aws:events:${var.aws_region}:${local.account_id}:rule/spawnpoint-control-plane-terminal-reconcile"
  control_plane_view_table_arn    = "arn:aws:dynamodb:${var.aws_region}:${local.account_id}:table/${var.control_plane_view_table_name}"
  promote_release_arn             = "arn:aws:states:${var.aws_region}:${local.account_id}:stateMachine:spawnpoint-promote-release"
  control_plane_operation_machines = [
    { type = "start", arn = local.lifecycle_v2_start_arn },
    { type = "stop", arn = local.lifecycle_v2_stop_arn },
    { type = "promote", arn = local.promote_release_arn },
    { type = "world", arn = "arn:aws:states:${var.aws_region}:${local.account_id}:stateMachine:spawnpoint-world-lifecycle" },
  ]
}

data "archive_file" "control_plane_projector" {
  type        = "zip"
  source_dir  = "${path.module}/../../lambdas/dist/control-plane-projector"
  output_path = "${path.module}/../../lambdas/dist/control-plane-projector.zip"
}

data "aws_iam_policy_document" "control_plane_projector_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "control_plane_projector" {
  name               = "spawnpoint-control-plane-projector"
  assume_role_policy = data.aws_iam_policy_document.control_plane_projector_assume.json
}

resource "aws_iam_role_policy_attachment" "control_plane_projector_logs" {
  role       = aws_iam_role.control_plane_projector.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

data "aws_iam_policy_document" "control_plane_projector" {
  statement {
    sid       = "WriteControlPlaneProjection"
    actions   = ["dynamodb:PutItem"]
    resources = [local.control_plane_view_table_arn]
  }

  statement {
    sid       = "ReadLifecycleForRecovery"
    actions   = ["dynamodb:GetItem"]
    resources = [data.aws_dynamodb_table.lifecycle.arn]
  }

  statement {
    sid       = "ObserveGameHost"
    actions   = ["ec2:DescribeInstances"]
    resources = ["*"]
  }

  statement {
    sid       = "ObserveOperations"
    actions   = ["states:ListExecutions"]
    resources = [for machine in local.control_plane_operation_machines : machine.arn]
  }

  statement {
    sid       = "RecoverOnlyThroughFencedStop"
    actions   = ["states:StartExecution"]
    resources = [local.lifecycle_v2_stop_arn]
  }

  statement {
    sid       = "PublishProjectionInvalidations"
    actions   = ["events:PutEvents"]
    resources = ["arn:aws:events:${var.aws_region}:${local.account_id}:event-bus/default"]
  }
}

resource "aws_iam_role_policy" "control_plane_projector" {
  name   = "spawnpoint-control-plane-projector"
  role   = aws_iam_role.control_plane_projector.id
  policy = data.aws_iam_policy_document.control_plane_projector.json
}

resource "aws_cloudwatch_log_group" "control_plane_projector" {
  name              = "/aws/lambda/spawnpoint-control-plane-projector"
  retention_in_days = 14
}

resource "aws_lambda_function" "control_plane_projector" {
  function_name    = "spawnpoint-control-plane-projector"
  role             = aws_iam_role.control_plane_projector.arn
  runtime          = "nodejs22.x"
  handler          = "index.handler"
  filename         = data.archive_file.control_plane_projector.output_path
  source_code_hash = data.archive_file.control_plane_projector.output_base64sha256
  timeout          = 30
  memory_size      = 256

  environment {
    variables = {
      CONTROL_PLANE_VIEW_TABLE = var.control_plane_view_table_name
      LIFECYCLE_TABLE_NAME     = data.aws_dynamodb_table.lifecycle.name
      OPERATION_STATE_MACHINES = jsonencode(local.control_plane_operation_machines)
    }
  }

  depends_on = [aws_cloudwatch_log_group.control_plane_projector]
}

resource "aws_cloudwatch_event_rule" "control_plane_host_state" {
  name        = "spawnpoint-control-plane-host-state"
  description = "Refresh the dashboard projection when the shared host changes state."
  event_pattern = jsonencode({
    source        = ["aws.ec2"]
    "detail-type" = ["EC2 Instance State-change Notification"]
    detail = {
      "instance-id" = [data.aws_instance.game_host.id]
      state         = ["pending", "running", "stopping", "stopped"]
    }
  })
}

resource "aws_cloudwatch_event_target" "control_plane_host_state" {
  rule = aws_cloudwatch_event_rule.control_plane_host_state.name
  arn  = aws_lambda_function.control_plane_projector.arn
}

resource "aws_lambda_permission" "control_plane_host_state" {
  statement_id  = "AllowHostStateProjection"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.control_plane_projector.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.control_plane_host_state.arn
}

resource "aws_cloudwatch_event_rule" "control_plane_execution_state" {
  name        = "spawnpoint-control-plane-execution-state"
  description = "Refresh the dashboard projection when a supported operation changes state."
  event_pattern = jsonencode({
    source        = ["aws.states"]
    "detail-type" = ["Step Functions Execution Status Change"]
    detail = {
      stateMachineArn = [for machine in local.control_plane_operation_machines : machine.arn]
      status          = ["RUNNING", "SUCCEEDED", "FAILED", "TIMED_OUT", "ABORTED"]
    }
  })
}

resource "aws_cloudwatch_event_target" "control_plane_execution_state" {
  rule = aws_cloudwatch_event_rule.control_plane_execution_state.name
  arn  = aws_lambda_function.control_plane_projector.arn
}

resource "aws_lambda_permission" "control_plane_execution_state" {
  statement_id  = "AllowExecutionStateProjection"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.control_plane_projector.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.control_plane_execution_state.arn
}

# A stopped event can arrive before the lifecycle lease expires. This one-shot
# workflow revisits that exact observation after the longest accepted lease;
# unlike a schedule it owns no recurring work while the system is idle.
data "aws_iam_policy_document" "control_plane_reconcile_assume" {
  statement {
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
      values   = [local.control_plane_reconcile_arn]
    }
  }
}

resource "aws_iam_role" "control_plane_reconcile" {
  name               = "spawnpoint-control-plane-reconcile-stopped"
  assume_role_policy = data.aws_iam_policy_document.control_plane_reconcile_assume.json
}

data "aws_iam_policy_document" "control_plane_reconcile" {
  statement {
    actions   = ["lambda:InvokeFunction"]
    resources = [local.control_plane_projector_arn]
  }
}

resource "aws_iam_role_policy" "control_plane_reconcile" {
  name   = "spawnpoint-control-plane-reconcile-stopped"
  role   = aws_iam_role.control_plane_reconcile.id
  policy = data.aws_iam_policy_document.control_plane_reconcile.json
}

resource "aws_sfn_state_machine" "control_plane_reconcile" {
  name     = "spawnpoint-control-plane-reconcile-stopped"
  role_arn = aws_iam_role.control_plane_reconcile.arn
  type     = "STANDARD"
  definition = jsonencode({
    Comment = "One-shot reconciliation after a stopped host outlives its lifecycle lease"
    StartAt = "WaitBeyondLease"
    States = {
      WaitBeyondLease = {
        Type    = "Wait"
        Seconds = 1860
        Next    = "RefreshProjection"
      }
      RefreshProjection = {
        Type     = "Task"
        Resource = "arn:aws:states:::lambda:invoke"
        Parameters = {
          FunctionName = local.control_plane_projector_arn
          Payload = {
            "id.$"        = "States.Format('{}-deferred', $.id)"
            source        = "spawnpoint.reconciliation"
            "detail-type" = "Deferred Control Plane Reconciliation"
            "time.$"      = "$$.State.EnteredTime"
            detail        = { trigger = "stopped-host-lease-expiry" }
          }
        }
        Retry = [{
          ErrorEquals     = ["Lambda.ServiceException", "Lambda.AWSLambdaException", "Lambda.SdkClientException", "Lambda.TooManyRequestsException"]
          IntervalSeconds = 2
          MaxAttempts     = 3
          BackoffRate     = 2
        }]
        End = true
      }
    }
  })

  depends_on = [aws_iam_role_policy.control_plane_reconcile]
}

data "aws_iam_policy_document" "control_plane_reconcile_events_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["events.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }

    condition {
      test     = "ArnEquals"
      variable = "aws:SourceArn"
      values   = [local.control_plane_stopped_rule_arn, local.control_plane_terminal_rule_arn]
    }
  }
}

resource "aws_iam_role" "control_plane_reconcile_events" {
  name               = "spawnpoint-control-plane-reconcile-events"
  assume_role_policy = data.aws_iam_policy_document.control_plane_reconcile_events_assume.json
}

data "aws_iam_policy_document" "control_plane_reconcile_events" {
  statement {
    actions   = ["states:StartExecution"]
    resources = [aws_sfn_state_machine.control_plane_reconcile.arn]
  }
}

resource "aws_iam_role_policy" "control_plane_reconcile_events" {
  name   = "spawnpoint-control-plane-reconcile-events"
  role   = aws_iam_role.control_plane_reconcile_events.id
  policy = data.aws_iam_policy_document.control_plane_reconcile_events.json
}

resource "aws_cloudwatch_event_rule" "control_plane_stopped_reconcile" {
  name        = "spawnpoint-control-plane-stopped-reconcile"
  description = "Start one delayed reconciliation when the shared host reaches stopped."
  event_pattern = jsonencode({
    source        = ["aws.ec2"]
    "detail-type" = ["EC2 Instance State-change Notification"]
    detail = {
      "instance-id" = [data.aws_instance.game_host.id]
      state         = ["stopped"]
    }
  })
}

resource "aws_cloudwatch_event_target" "control_plane_stopped_reconcile" {
  rule     = aws_cloudwatch_event_rule.control_plane_stopped_reconcile.name
  arn      = aws_sfn_state_machine.control_plane_reconcile.arn
  role_arn = aws_iam_role.control_plane_reconcile_events.arn

  depends_on = [aws_iam_role_policy.control_plane_reconcile_events]
}

# A terminal workflow can fail after the host's final EC2 event was already
# delivered. Schedule the same one-shot check from that independent signal so
# a failed lifecycle write cannot require a dashboard repair button.
resource "aws_cloudwatch_event_rule" "control_plane_terminal_reconcile" {
  name        = "spawnpoint-control-plane-terminal-reconcile"
  description = "Schedule one delayed reconciliation after a supported operation completes."
  event_pattern = jsonencode({
    source        = ["aws.states"]
    "detail-type" = ["Step Functions Execution Status Change"]
    detail = {
      stateMachineArn = [for machine in local.control_plane_operation_machines : machine.arn]
      status          = ["FAILED", "TIMED_OUT", "ABORTED"]
    }
  })
}

resource "aws_cloudwatch_event_target" "control_plane_terminal_reconcile" {
  rule     = aws_cloudwatch_event_rule.control_plane_terminal_reconcile.name
  arn      = aws_sfn_state_machine.control_plane_reconcile.arn
  role_arn = aws_iam_role.control_plane_reconcile_events.arn

  depends_on = [aws_iam_role_policy.control_plane_reconcile_events]
}
