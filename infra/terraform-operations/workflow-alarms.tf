# The machines every start and stop runs through. Promotion and the projector
# reconcile are left out: a failure there is visible where it is started.
locals {
  workflow_alarm_metrics = {
    ExecutionsFailed   = "failed"
    ExecutionsTimedOut = "timed-out"
  }

  workflow_alarms = merge([
    for machine, arn in {
      "start-server-v2"  = local.lifecycle_v2_start_arn
      "stop-server-v2"   = local.lifecycle_v2_stop_arn
      "drain-host-v2"    = local.lifecycle_v2_drain_arn
      "idle-watchdog-v2" = local.lifecycle_v2_watchdog_arn
      } : {
      for metric, outcome in local.workflow_alarm_metrics :
      "spawnpoint-${machine}-${outcome}" => { machine = machine, arn = arn, metric = metric, outcome = outcome }
    }
  ]...)

  workflow_filtered = {
    for name, alarm in local.workflow_alarms :
    name => alarm.metric == "ExecutionsFailed" && contains(keys(local.workflow_expected_errors), alarm.machine)
  }
}

# A stop refused because players are online ends the execution as FAILED on
# purpose. AWS/States counts it like any other failure, so the failed alarm of
# this machine counts a rule's matches instead: every FAILED execution except
# the errors that are outcomes. A missing or null error still counts.
locals {
  workflow_expected_errors = {
    "stop-server-v2" = { arn = local.lifecycle_v2_stop_arn, errors = ["Spawnpoint.V2StopRefusedPlayersOnline"] }
  }
}

resource "aws_cloudwatch_event_rule" "workflow_failed" {
  for_each = local.workflow_expected_errors

  name        = "spawnpoint-${each.key}-failed"
  description = "A spawnpoint-${each.key} execution failed for a reason that is not an expected outcome."
  event_pattern = jsonencode({
    source        = ["aws.states"]
    "detail-type" = ["Step Functions Execution Status Change"]
    detail = {
      stateMachineArn = [each.value.arn]
      status          = ["FAILED"]
      "$or" = [
        { error = [{ "anything-but" = each.value.errors }] },
        { error = [{ exists = false }] },
        { error = [null] },
      ]
    }
  })

  tags = {
    Name = "spawnpoint-${each.key}-failed"
  }
}

# The rule needs a target to run. The log group also keeps each failure's event.
resource "aws_cloudwatch_log_group" "workflow_failed" {
  for_each = local.workflow_expected_errors

  name              = "/aws/events/spawnpoint-${each.key}-failed"
  retention_in_days = 30
}

resource "aws_cloudwatch_event_target" "workflow_failed" {
  for_each = local.workflow_expected_errors

  rule = aws_cloudwatch_event_rule.workflow_failed[each.key].name
  arn  = aws_cloudwatch_log_group.workflow_failed[each.key].arn
}

resource "aws_cloudwatch_log_resource_policy" "workflow_failed" {
  policy_name = "spawnpoint-operations-workflow-failed"
  policy_document = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = ["events.amazonaws.com", "delivery.logs.amazonaws.com"] }
      Action    = ["logs:CreateLogStream", "logs:PutLogEvents"]
      Resource  = [for group in aws_cloudwatch_log_group.workflow_failed : "${group.arn}:*"]
    }]
  })
}

resource "aws_cloudwatch_metric_alarm" "workflow" {
  for_each = local.workflow_alarms

  alarm_name        = each.key
  alarm_description = "An execution of spawnpoint-${each.value.machine} ${replace(each.value.outcome, "-", " ")}. Open it in the Step Functions console to see the failed state."

  # A machine with expected errors counts its filtered rule for failures.
  namespace   = local.workflow_filtered[each.key] ? "AWS/Events" : "AWS/States"
  metric_name = local.workflow_filtered[each.key] ? "MatchedEvents" : each.value.metric
  dimensions = (
    local.workflow_filtered[each.key]
    ? tomap({ RuleName = aws_cloudwatch_event_rule.workflow_failed[each.value.machine].name })
    : tomap({ StateMachineArn = each.value.arn })
  )

  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"

  alarm_actions = [data.aws_sns_topic.fleet_alerts.arn]
  ok_actions    = [data.aws_sns_topic.fleet_alerts.arn]

  tags = {
    Name = each.key
  }
}
