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

variable "game_dns_zone_name" {
  description = "Optional Route 53 public hosted zone containing game DNS records."
  type        = string
  default     = ""
}

variable "game_dns_suffix" {
  description = "Optional DNS suffix for world records, within game_dns_zone_name."
  type        = string
  default     = ""

  validation {
    condition = (var.game_dns_zone_name == "" && var.game_dns_suffix == "") || (
      var.game_dns_zone_name != "" && var.game_dns_suffix != "" &&
      (var.game_dns_suffix == var.game_dns_zone_name || endswith(var.game_dns_suffix, ".${var.game_dns_zone_name}"))
    )
    error_message = "Game DNS zone and suffix must be configured together, with the suffix inside the zone."
  }
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

variable "launch_families" {
  description = "The instance families a launched host may be, as EC2 Fleet AllowedInstanceTypes patterns (ADR-0054): a filter, never a ranking. Mirrors launchFamilies in lambdas/src/control-plane/catalog.ts; a test keeps them equal."
  type        = list(string)
  default     = ["m7i-flex.*", "m7i.*", "r7i.*", "r8i-flex.*", "r8i.*", "c7i.*"]
}

variable "drain_grace_seconds" {
  description = "How long an empty launched host waits for a start to take it back before it is let go (ADR-0054)."
  type        = number
  default     = 600
}

variable "headroom_mib" {
  description = "Memory the fleet keeps free somewhere while anything runs, so the next start lands on a host already up (ADR-0054). Zero keeps nothing."
  type        = number
  default     = 0
}

variable "drain_max_keep_polls" {
  description = "How many grace periods a drain may be told to keep waiting — an empty host held for headroom — before the drain gives up loudly. 288 of 600 seconds is two days."
  type        = number
  default     = 288
}
