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

variable "github_repository_subject" {
  description = "OIDC subject of this repository without its environment: `repo:owner/name`, or `repo:owner@id/name@id` when the repository uses immutable ids. CI reads it from its own token; a local apply passes it."
  type        = string

  validation {
    condition     = can(regex("^repo:[^:]+$", var.github_repository_subject))
    error_message = "github_repository_subject must be repo:<owner>/<name> with no environment or ref."
  }
}

variable "github_subjects" {
  description = "Exact OIDC subjects of the config repositories allowed to publish catalogs and request release builds. Empty creates no release role. CI reads the CONFIG_REPOSITORY_SUBJECTS repository variable."
  type        = set(string)
  default     = []

  validation {
    condition = alltrue([
      for subject in var.github_subjects : can(regex("^repo:[^:]+:ref:refs/heads/[^:]+$", subject))
    ])
    error_message = "Each entry must be an exact repository branch subject claim emitted by GitHub OIDC."
  }
}
