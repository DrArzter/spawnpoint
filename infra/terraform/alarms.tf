# The topic lives in ../terraform-guardrails, found by name the same way the
# storage buckets are: a convention, not shared state.
data "aws_sns_topic" "alerts" {
  name = "spawnpoint-alert"
}

# Presence-of-metric trick: EC2 only emits CPUUtilization while the instance
# runs, and any reading beats a threshold of -1. N consecutive hourly datapoints
# therefore mean "running for N hours straight", with no code anywhere.
resource "aws_cloudwatch_metric_alarm" "running_hours" {
  alarm_name        = "spawnpoint-running-hours"
  alarm_description = "Game host running ${var.running_hours_alarm_hours}h straight — the watchdog or its stop has failed. A silent stop failure costs ~USD 129/month. See docs/runbook.md."

  namespace   = "AWS/EC2"
  metric_name = "CPUUtilization"
  dimensions = {
    InstanceId = aws_instance.game_host.id
  }

  statistic           = "Average"
  period              = 3600
  evaluation_periods  = var.running_hours_alarm_hours
  threshold           = -1
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"

  alarm_actions = [data.aws_sns_topic.alerts.arn]
  ok_actions    = [data.aws_sns_topic.alerts.arn]

  tags = {
    Name = "spawnpoint-running-hours"
  }
}

# V1 machines run only as children of the V2 machines (../terraform-operations),
# which catch their failures and compensate. Their own alarm still matters: a
# failed V1 stop is the "backup did not complete" signal of ADR-0015.
locals {
  workflow_alarm_metrics = {
    ExecutionsFailed   = "failed"
    ExecutionsTimedOut = "timed-out"
  }

  workflow_alarms = merge([
    for machine, arn in {
      "start-server" = aws_sfn_state_machine.start_server.arn
      "stop-server"  = aws_sfn_state_machine.stop_server.arn
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
    "stop-server" = { arn = aws_sfn_state_machine.stop_server.arn, errors = ["Spawnpoint.PlayersOnline"] }
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
  policy_name = "spawnpoint-core-workflow-failed"
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

  alarm_name = each.key
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

  alarm_actions = [data.aws_sns_topic.alerts.arn]
  ok_actions    = [data.aws_sns_topic.alerts.arn]

  tags = {
    Name = each.key
  }
}

# Every host, configured and launched, in one sum: launched hosts come and go,
# so a per-instance alarm cannot follow them. A Metrics Insights query reads
# every EC2 instance in the region; the account holds only Spawnpoint hosts.
resource "aws_cloudwatch_metric_alarm" "egress" {
  alarm_name        = "spawnpoint-egress"
  alarm_description = "Game hosts sent more than ${var.egress_alarm_gib_per_hour} GiB in one hour. Unusual transfer is billed per GB (ADR-0013). Check which host sent it in the EC2 NetworkOut metrics."

  metric_query {
    id          = "egress"
    expression  = "SELECT SUM(NetworkOut) FROM SCHEMA(\"AWS/EC2\", InstanceId)"
    period      = 3600
    return_data = true
  }

  evaluation_periods  = 1
  threshold           = var.egress_alarm_gib_per_hour * 1073741824
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"

  alarm_actions = [data.aws_sns_topic.alerts.arn]
  ok_actions    = [data.aws_sns_topic.alerts.arn]

  tags = {
    Name = "spawnpoint-egress"
  }
}
