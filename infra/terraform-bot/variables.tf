variable "aws_region" {
  description = "Region containing the Spawnpoint control plane and game host."
  type        = string
  default     = "eu-central-1"

  validation {
    condition     = var.aws_region == "eu-central-1"
    error_message = "The existing host, release bucket and workflows are in eu-central-1."
  }
}

variable "aws_profile" {
  description = "Shared AWS CLI profile used locally; never a credential value."
  type        = string
  default     = "spawnpoint"
}

variable "connection_address" {
  description = "Stable overlay address returned by /status and by the start workflow."
  type        = string
  default     = "172.29.23.24:25565"
}

variable "enable_notifications" {
  description = "Deploy the EventBridge/SNS-to-Telegram notifier after the command bot is accepted."
  type        = bool
  default     = false
}
