variable "aws_region" {
  description = "Region containing the release-build state machine."
  type        = string
  default     = "eu-central-1"

  validation {
    condition     = var.aws_region == "eu-central-1"
    error_message = "The release pipeline currently exists only in eu-central-1."
  }
}

variable "aws_profile" {
  description = "Shared AWS CLI profile used locally; never a credential value."
  type        = string
  default     = "spawnpoint"
}

variable "github_repository" {
  description = "The single owner/repository allowed to request an AWS release build."
  type        = string
  default     = "DrArzter/my-docker-minecraft-server-config"

  validation {
    condition     = can(regex("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", var.github_repository))
    error_message = "Use the GitHub owner/repository form."
  }
}

variable "github_branch" {
  description = "The only branch whose workflow may assume the AWS release role."
  type        = string
  default     = "main"

  validation {
    condition     = can(regex("^[A-Za-z0-9._/-]+$", var.github_branch))
    error_message = "Provide a valid branch name without a refs/heads/ prefix."
  }
}
