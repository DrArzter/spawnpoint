mock_provider "aws" {
  override_during = plan

  override_data {
    target = data.aws_caller_identity.current
    values = {
      account_id = "123456789012"
    }
  }

  override_data {
    target = data.aws_iam_policy_document.alerts
    values = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}"
    }
  }
}

variables {
  alert_email = "owner@example.com"
}

run "budget_and_topic_guard_the_account" {
  command = plan

  assert {
    condition     = aws_sns_topic.alerts.name == "spawnpoint-alerts"
    error_message = "Every alerting service converges on the one spawnpoint-alerts topic."
  }

  assert {
    condition = (
      aws_sns_topic_subscription.alerts_email.protocol == "email" &&
      aws_sns_topic_subscription.alerts_email.endpoint == "owner@example.com"
    )
    error_message = "The alert email must be subscribed to the topic; unconfirmed means silently undelivered."
  }

  assert {
    condition     = tonumber(aws_budgets_budget.monthly.limit_amount) == 20 && aws_budgets_budget.monthly.time_unit == "MONTHLY"
    error_message = "The monthly budget must default to the documented $20 line."
  }

  assert {
    condition = toset([
      for n in aws_budgets_budget.monthly.notification : n.notification_type
    ]) == toset(["FORECASTED", "ACTUAL"])
    error_message = "Both thresholds are required: forecast catches a runaway early, actual is the backstop."
  }

  # The topic ARN is computed — unknown at plan under the mock provider — so
  # equality against it cannot be asserted here (the same lesson as the
  # notifier's rule assertions). What plan does know: every notification names
  # exactly one SNS subscriber and no email subscribers, which is the shape
  # that guarantees convergence on the one topic this root creates.
  assert {
    condition = alltrue([
      for n in aws_budgets_budget.monthly.notification :
      length(n.subscriber_sns_topic_arns) == 1 && length(coalesce(n.subscriber_email_addresses, [])) == 0
    ])
    error_message = "Budget alerts must go through the SNS topic, where later alarms and adapters also converge."
  }

  assert {
    condition     = one(aws_budgets_budget.monthly.cost_types).include_credit == false
    error_message = "The budget must measure cost before credits, or Free Plan credits mute it entirely."
  }

  assert {
    condition     = length(aws_ce_anomaly_monitor.services) == 1 && length(aws_ce_anomaly_subscription.services) == 1
    error_message = "Anomaly detection is expected in the default plan."
  }

  assert {
    condition     = aws_ce_anomaly_subscription.services[0].frequency == "IMMEDIATE"
    error_message = "Individual anomaly alerts must be immediate; email-only delivery works just for summaries."
  }
}

run "anomaly_detection_can_wait_for_cost_explorer" {
  command = plan

  variables {
    enable_anomaly_detection = false
  }

  assert {
    condition     = length(aws_ce_anomaly_monitor.services) == 0 && length(aws_ce_anomaly_subscription.services) == 0
    error_message = "With anomaly detection disabled, only the budget and topic are planned."
  }

  assert {
    condition     = aws_sns_topic.alerts.name == "spawnpoint-alerts"
    error_message = "The topic and budget must not depend on the anomaly toggle."
  }
}
