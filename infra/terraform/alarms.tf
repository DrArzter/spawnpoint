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
}

resource "aws_cloudwatch_metric_alarm" "workflow" {
  for_each = local.workflow_alarms

  alarm_name = each.key
  alarm_description = join(" ", compact([
    "An execution of spawnpoint-${each.value.machine} ${replace(each.value.outcome, "-", " ")}. Open it in the Step Functions console to see the failed state.",
    # A player who joins after the idle check makes a stop refuse, which is correct.
    each.value.machine == "stop-server" && each.value.metric == "ExecutionsFailed" ? "If its error is Spawnpoint.PlayersOnline, a player joined and the stop was refused: no action is needed." : "",
  ]))

  namespace   = "AWS/States"
  metric_name = each.value.metric
  dimensions = {
    StateMachineArn = each.value.arn
  }

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
