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
}

resource "aws_cloudwatch_metric_alarm" "workflow" {
  for_each = local.workflow_alarms

  alarm_name = each.key
  alarm_description = join(" ", compact([
    "An execution of spawnpoint-${each.value.machine} ${replace(each.value.outcome, "-", " ")}. Open it in the Step Functions console to see the failed state.",
    # A player who joins after the idle check makes a stop refuse, which is correct.
    each.value.machine == "stop-server-v2" && each.value.metric == "ExecutionsFailed" ? "If its error is Spawnpoint.V2StopRefusedPlayersOnline, a player joined and the stop was refused: no action is needed." : "",
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

  alarm_actions = [data.aws_sns_topic.fleet_alerts.arn]
  ok_actions    = [data.aws_sns_topic.fleet_alerts.arn]

  tags = {
    Name = each.key
  }
}
