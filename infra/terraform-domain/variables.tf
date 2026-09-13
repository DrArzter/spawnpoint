variable "aws_region" {
  description = "AWS provider region; Route 53 public zones are global resources."
  type        = string
}

variable "aws_profile" {
  description = "Shared AWS CLI profile used locally; never a credential value."
  type        = string
}

variable "domain_name" {
  description = "Spawnpoint subdomain delegated from the parent Namecheap zone to Route 53."
  type        = string

  validation {
    condition     = var.domain_name == trimsuffix(lower(var.domain_name), ".") && can(regex("^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$", var.domain_name))
    error_message = "domain_name must be a lowercase fully qualified domain name without a trailing dot."
  }
}
