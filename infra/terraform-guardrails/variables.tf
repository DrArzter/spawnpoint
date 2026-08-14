variable "aws_region" {
  description = "Region for the alert topic. Budgets and Cost Explorer are global; the SNS topic is regional and stays beside the stack."
  type        = string
  default     = "eu-central-1"

  validation {
    condition     = var.aws_region == "eu-central-1"
    error_message = "Keep the alert topic in the same region as the rest of the stack."
  }
}

variable "aws_profile" {
  description = "Shared AWS CLI profile used locally; never a credential value."
  type        = string
  default     = "spawnpoint"
}

variable "alert_email" {
  description = "Address that receives budget and anomaly alerts. Its SNS subscription must be confirmed once from this inbox."
  type        = string

  validation {
    condition     = can(regex("^[^@[:space:]]+@[^@[:space:]]+\\.[^@[:space:]]+$", var.alert_email))
    error_message = "Provide a single valid email address."
  }
}

variable "monthly_budget_usd" {
  description = "Monthly cost budget. Set above the modelled spend and well below a surprise; one that trips in a normal month gets muted."
  type        = number
  default     = 20

  validation {
    condition     = var.monthly_budget_usd >= 5
    error_message = "A budget below a few dollars trips every normal month and trains you to ignore it."
  }
}

variable "anomaly_impact_usd" {
  description = "Absolute dollar impact above which a cost anomaly raises an immediate alert. AWS's default of $100 never fires on a small account."
  type        = number
  default     = 5

  validation {
    condition     = var.anomaly_impact_usd >= 1
    error_message = "Keep the anomaly impact threshold at a dollar or more to avoid noise."
  }
}

variable "enable_anomaly_detection" {
  description = "Cost anomaly detection needs Cost Explorer, which can lag a new account by a day. Set false to apply the budget and topic first, then true once Cost Explorer is ready."
  type        = bool
  default     = true
}
