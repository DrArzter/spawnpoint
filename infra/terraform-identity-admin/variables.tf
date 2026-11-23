variable "aws_region" {
  description = "Region of the state bucket and the GitHub identities this role may change."
  type        = string
  default     = "eu-central-1"

  validation {
    condition     = var.aws_region == "eu-central-1"
    error_message = "Spawnpoint currently exists only in eu-central-1."
  }
}

variable "aws_profile" {
  description = "Shared AWS CLI profile used locally; never a credential value."
  type        = string
  default     = "spawnpoint"
}

variable "github_repository_subject" {
  description = "OIDC subject of this repository without its environment: `repo:owner/name`, or `repo:owner@id/name@id` when the repository uses immutable ids."
  type        = string

  validation {
    condition     = can(regex("^repo:[^:]+$", var.github_repository_subject))
    error_message = "github_repository_subject must be repo:<owner>/<name> with no environment or ref."
  }
}
