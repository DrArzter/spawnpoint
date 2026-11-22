variable "aws_region" {
  description = "Region containing persistent Spawnpoint object storage."
  type        = string
  default     = "eu-central-1"

  validation {
    condition     = var.aws_region == "eu-central-1"
    error_message = "Production storage stays in eu-central-1."
  }
}

variable "aws_profile" {
  description = "Shared AWS CLI profile used locally; never a credential value."
  type        = string
  default     = "spawnpoint"
}

variable "release_refs_table_name" {
  description = "DynamoDB table holding the back-references and holders of content-addressed releases (ADR-0080)."
  type        = string
  default     = "spawnpoint-release-refs"

  validation {
    condition     = can(regex("^[A-Za-z0-9_.-]{3,255}$", var.release_refs_table_name))
    error_message = "release_refs_table_name must be a valid DynamoDB table name."
  }
}

variable "release_reconciler_role_name" {
  description = "The only IAM role allowed to delete an object under objects/ (ADR-0080). The role lives in ../terraform-operations; this name must match it."
  type        = string
  default     = "spawnpoint-release-reconciler"

  validation {
    condition     = can(regex("^[A-Za-z0-9+=,.@_-]{1,64}$", var.release_reconciler_role_name))
    error_message = "release_reconciler_role_name must be a valid IAM role name."
  }
}

variable "control_plane_view_table_name" {
  description = "DynamoDB table holding bounded control-plane events and the rebuildable dashboard projection."
  type        = string
  default     = "spawnpoint-control-plane-view"

  validation {
    condition     = can(regex("^[A-Za-z0-9_.-]{3,255}$", var.control_plane_view_table_name))
    error_message = "control_plane_view_table_name must be a valid DynamoDB table name."
  }
}
