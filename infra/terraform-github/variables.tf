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

variable "github_subjects" {
  description = "Exact GitHub OIDC subject claims allowed to publish catalogs and request release builds."
  type        = set(string)
  default = [
    "repo:DrArzter/my-docker-minecraft-server-config:ref:refs/heads/main",
    "repo:DrArzter@102290466/my-docker-factorio-server-config@1348549387:ref:refs/heads/main",
    "repo:DrArzter@102290466/my-docker-zomboid-server-config@1352117153:ref:refs/heads/main",
  ]

  validation {
    condition = length(var.github_subjects) > 0 && alltrue([
      for subject in var.github_subjects : can(regex("^repo:[^:]+:ref:refs/heads/[^:]+$", subject))
    ])
    error_message = "Each entry must be an exact repository branch subject claim emitted by GitHub OIDC."
  }
}
