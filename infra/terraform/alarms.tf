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
