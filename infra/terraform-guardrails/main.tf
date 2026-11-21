data "aws_caller_identity" "current" {}

# --- Alert topic: the one place budgets, anomaly detection and later CloudWatch
#     alarms and chat adapters converge on ---

resource "aws_sns_topic" "alerts" {
  name = "spawnpoint-alert"

  tags = {
    Name    = "spawnpoint-alert"
    Purpose = "cost-and-operational-alerts"
  }
}

data "aws_iam_policy_document" "alerts" {
  statement {
    sid       = "AllowServiceAlertsToPublish"
    effect    = "Allow"
    actions   = ["SNS:Publish"]
    resources = [aws_sns_topic.alerts.arn]

    # Each alerting service is a distinct principal: Budgets and Cost Anomaly
    # Detection. One statement lists both.
    principals {
      type = "Service"
      identifiers = [
        "budgets.amazonaws.com",
        "costalerts.amazonaws.com",
      ]
    }

    # Scope the grant to alerts raised on behalf of THIS account, so neither
    # service can be induced to publish here on behalf of another account.
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }
}

resource "aws_sns_topic_policy" "alerts" {
  arn    = aws_sns_topic.alerts.arn
  policy = data.aws_iam_policy_document.alerts.json
}

# Created PendingConfirmation. Terraform cannot confirm an email subscription;
# the recipient clicks the link once. That click is the only step this root
# leaves to a human.
resource "aws_sns_topic_subscription" "alerts_email" {
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

# --- Budget: forecasted catches a runaway days early, actual is the backstop ---

resource "aws_budgets_budget" "monthly" {
  name         = "spawnpoint-monthly"
  budget_type  = "COST"
  limit_amount = tostring(var.monthly_budget_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  # Measure cost BEFORE credits, so the budget still fires on a runaway while
  # Free Plan credits would otherwise net the reported amount to zero. See
  # docs/aws-account-checklist.md.
  cost_types {
    include_credit = false
    include_refund = false
  }

  notification {
    comparison_operator       = "GREATER_THAN"
    threshold                 = 100
    threshold_type            = "PERCENTAGE"
    notification_type         = "FORECASTED"
    subscriber_sns_topic_arns = [aws_sns_topic.alerts.arn]
  }

  notification {
    comparison_operator       = "GREATER_THAN"
    threshold                 = 100
    threshold_type            = "PERCENTAGE"
    notification_type         = "ACTUAL"
    subscriber_sns_topic_arns = [aws_sns_topic.alerts.arn]
  }

  depends_on = [aws_sns_topic_policy.alerts]
}

# --- Cost anomaly detection: one monitor over all services, immediate alerts
#     via SNS. Optional, because it needs Cost Explorer enabled first ---

resource "aws_ce_anomaly_monitor" "services" {
  count = var.enable_anomaly_detection ? 1 : 0

  name              = "spawnpoint-services"
  monitor_type      = "DIMENSIONAL"
  monitor_dimension = "SERVICE"
}

resource "aws_ce_anomaly_subscription" "services" {
  count = var.enable_anomaly_detection ? 1 : 0

  name             = "spawnpoint-anomalies"
  frequency        = "IMMEDIATE"
  monitor_arn_list = [aws_ce_anomaly_monitor.services[0].arn]

  subscriber {
    type    = "SNS"
    address = aws_sns_topic.alerts.arn
  }

  threshold_expression {
    dimension {
      key           = "ANOMALY_TOTAL_IMPACT_ABSOLUTE"
      match_options = ["GREATER_THAN_OR_EQUAL"]
      values        = [tostring(var.anomaly_impact_usd)]
    }
  }

  # IMMEDIATE anomaly alerts must go to SNS, and the topic policy above must
  # already allow costalerts.amazonaws.com, or creation is rejected.
  depends_on = [aws_sns_topic_policy.alerts]
}
