# The topic lives in ../terraform-guardrails, found by name like the other roots.
data "aws_sns_topic" "alerts" {
  name = "spawnpoint-alert"
}

locals {
  world_lifecycle_alarm_metrics = {
    ExecutionsFailed   = "failed"
    ExecutionsTimedOut = "timed-out"
  }
}

# A failed run leaves a world change half applied after its session stopped.
resource "aws_cloudwatch_metric_alarm" "world_lifecycle" {
  for_each = local.world_lifecycle_alarm_metrics

  alarm_name        = "spawnpoint-world-lifecycle-${each.value}"
  alarm_description = "An execution of spawnpoint-world-lifecycle ${replace(each.value, "-", " ")}. Open it in the Step Functions console to see the failed state."

  namespace   = "AWS/States"
  metric_name = each.key
  dimensions = {
    StateMachineArn = local.world_lifecycle_arn
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
    Name = "spawnpoint-world-lifecycle-${each.value}"
  }
}
