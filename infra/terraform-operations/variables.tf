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

variable "control_plane_view_table_name" {
  description = "DynamoDB table holding the rebuildable dashboard projection produced by this root."
  type        = string
  default     = "spawnpoint-control-plane-view"

  validation {
    condition     = can(regex("^[A-Za-z0-9_.-]{3,255}$", var.control_plane_view_table_name))
    error_message = "control_plane_view_table_name must be a valid DynamoDB table name."
  }
}
