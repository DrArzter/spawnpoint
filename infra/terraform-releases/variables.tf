variable "aws_region" {
  description = "Region in which immutable releases are built."
  type        = string
  default     = "eu-central-1"

  validation {
    condition     = var.aws_region == "eu-central-1"
    error_message = "The existing release bucket and control plane are in eu-central-1."
  }
}

variable "aws_profile" {
  description = "Shared AWS CLI profile used locally; never a credential value."
  type        = string
  default     = "spawnpoint"
}

variable "release_storage_layout" {
  description = "Storage layout the release builder writes: legacy (per-release keys) or objects-v1 (content-addressed, ADR-0080). Keep legacy until the readers are deployed."
  type        = string
  default     = "legacy"

  validation {
    condition     = contains(["legacy", "objects-v1"], var.release_storage_layout)
    error_message = "release_storage_layout must be legacy or objects-v1."
  }
}

variable "release_refs_table_name" {
  description = "Name of the release reference table that terraform-storage creates."
  type        = string
  default     = "spawnpoint-release-refs"

  validation {
    condition     = can(regex("^[A-Za-z0-9_.-]{3,255}$", var.release_refs_table_name))
    error_message = "release_refs_table_name must be a valid DynamoDB table name."
  }
}
