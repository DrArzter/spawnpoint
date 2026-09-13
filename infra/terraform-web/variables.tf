variable "aws_region" {
  description = "Region containing the static site origin."
  type        = string
  default     = "eu-central-1"
}

variable "aws_profile" {
  description = "Shared AWS CLI profile used locally; never a credential value."
  type        = string
  default     = "spawnpoint"
}

variable "domain_name" {
  description = "Public hostname of the panel; its delegated Route 53 zone must already exist."
  type        = string

  validation {
    condition     = var.domain_name == trimsuffix(lower(var.domain_name), ".") && can(regex("^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$", var.domain_name))
    error_message = "domain_name must be a lowercase fully qualified domain name without a trailing dot."
  }
}
