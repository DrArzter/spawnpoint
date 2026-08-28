variable "aws_region" {
  description = "Region containing the Spawnpoint control plane."
  type        = string
  default     = "eu-central-1"
}

variable "aws_profile" {
  description = "Shared AWS CLI profile used locally; never a credential value."
  type        = string
  default     = "spawnpoint"
}

variable "panel_url" {
  description = "HTTPS origin receiving Cognito authorization-code callbacks."
  type        = string
  default     = "https://dwk99t8cin0cf.cloudfront.net/"
}

variable "bootstrap_owner_email" {
  description = "Exact verified Google email allowed to atomically claim the first Owner."
  type        = string
  sensitive   = true

  validation {
    condition     = can(regex("^[^@[:space:]]+@[^@[:space:]]+$", var.bootstrap_owner_email))
    error_message = "bootstrap_owner_email must be an email address explicitly selected by the operator."
  }
}

variable "google_client_id" {
  description = "Google OAuth web client id. Leave empty until the Google provider is configured."
  type        = string
  default     = ""
}

variable "google_client_secret" {
  description = "Google OAuth web client secret. Stored only in encrypted remote Terraform state and Cognito."
  type        = string
  sensitive   = true
  default     = ""
}

locals {
  google_enabled = var.google_client_id != "" && var.google_client_secret != ""
}
