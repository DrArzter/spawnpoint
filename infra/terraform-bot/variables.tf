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

variable "connection_host" {
  description = "Host part of every world's address — the overlay address this deployment publishes. Each game's port completes it."
  type        = string
  default     = "172.29.23.24"
}

variable "panel_address" {
  description = "Session-scoped Grafana URL reachable through the overlay."
  type        = string
  default     = "http://172.29.23.24:3000"
}

variable "zerotier_network_id" {
  description = "Public ZeroTier network identifier shown by the onboarding command; not an authorization secret."
  type        = string
  default     = "b6079f73c6698651"

  validation {
    condition     = can(regex("^[0-9a-f]{16}$", var.zerotier_network_id))
    error_message = "A ZeroTier network id is exactly 16 lowercase hexadecimal characters."
  }
}

variable "mini_app_url" {
  description = "Public HTTPS Telegram Mini App URL shown by the bot. Set it to a custom domain, CloudFront URL or another reachable self-hosted endpoint."
  type        = string

  validation {
    condition     = can(regex("^https://[^/?#]+(/[^?#]*)?$", var.mini_app_url))
    error_message = "mini_app_url must be one public HTTPS URL without a query or fragment."
  }
}

variable "enable_notifications" {
  description = "Deploy the accepted EventBridge/SNS-to-Telegram notification surface; disable only for an isolated bot bootstrap."
  type        = bool
  default     = true
}

variable "email_delivery_provider" {
  description = "Optional transactional email adapter used by the notifier. `none` keeps email out of a self-hosted deployment; `resend` enables the Resend HTTP adapter."
  type        = string
  default     = "none"

  validation {
    condition     = contains(["none", "resend"], var.email_delivery_provider)
    error_message = "email_delivery_provider must be none or resend."
  }
}

variable "resend_api_key_parameter" {
  description = "SecureString parameter containing a send-only Resend API key. The parameter value is never stored in Terraform or GitHub."
  type        = string
  default     = "/spawnpoint/email/resend-api-key"

  validation {
    condition     = can(regex("^/spawnpoint/email/[A-Za-z0-9_.-]+$", var.resend_api_key_parameter))
    error_message = "resend_api_key_parameter must stay below /spawnpoint/email/."
  }
}

variable "email_from" {
  description = "Verified sender used for transactional email, for example `Spawnpoint <notifications@example.com>`. Required when an email adapter is enabled."
  type        = string
  default     = ""

  validation {
    condition     = var.email_delivery_provider == "none" || can(regex("^[^\r\n<>]+ <[^@[:space:]]+@[^@[:space:]]+\\.[^@[:space:]]+>$", var.email_from))
    error_message = "email_from must be a display name and email address from a verified sending domain."
  }
}

variable "email_reply_to" {
  description = "Optional reply-to address for transactional email. Empty means replies go to the sender address."
  type        = string
  default     = ""

  validation {
    condition     = var.email_reply_to == "" || can(regex("^[^@[:space:]]+@[^@[:space:]]+\\.[^@[:space:]]+$", var.email_reply_to))
    error_message = "email_reply_to must be empty or one email address."
  }
}
