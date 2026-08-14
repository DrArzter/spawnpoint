output "alert_topic_arn" {
  description = "SNS topic that budgets, anomaly detection and later CloudWatch alarms publish to."
  value       = aws_sns_topic.alerts.arn
}

output "alert_email_pending_confirmation" {
  description = "The email subscription is inactive until this address confirms it from the link AWS sends."
  value       = var.alert_email
}

output "budget_name" {
  description = "Monthly cost budget guarding the account."
  value       = aws_budgets_budget.monthly.name
}
