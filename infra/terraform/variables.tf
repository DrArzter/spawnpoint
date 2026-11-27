variable "aws_region" {
  description = "AWS region containing the game host and its zonal data volume."
  type        = string
  default     = "eu-central-1"

  validation {
    condition     = var.aws_region == "eu-central-1"
    error_message = "The measured player region and current data lineage are fixed to eu-central-1."
  }
}

variable "aws_profile" {
  description = "Shared AWS CLI profile used for local Terraform operations; never a credential value."
  type        = string
  default     = "spawnpoint"
}

variable "availability_zone" {
  description = "Account-specific AZ name corresponding to availability_zone_id."
  type        = string
  default     = "eu-central-1a"
}

variable "availability_zone_id" {
  description = "Stable physical AZ identifier; protects against account-specific AZ name remapping."
  type        = string
  default     = "euc1-az2"
}


variable "egress_alarm_gib_per_hour" {
  description = "GiB all game hosts may send in one hour before the egress alarm fires. A session sends tens of MB per player-hour; a backup upload sends a few GiB once."
  type        = number
  default     = 10

  validation {
    condition     = var.egress_alarm_gib_per_hour > 0
    error_message = "An egress threshold of zero fires on every session."
  }
}

variable "repository_url" {
  description = "Where a launched host checks this repository out from at first boot (ADR-0054, phase 12). Public, so the host needs no credential to read it. The deploy workflows pass the repository they run in."
  type        = string

  validation {
    condition     = startswith(var.repository_url, "https://")
    error_message = "repository_url must be an https URL."
  }
}

variable "host_parameter_path" {
  description = "Parameter Store path under which a launched host finds its runtime environment (`/env/<KEY>`)."
  type        = string
  default     = "/spawnpoint/host"

  validation {
    condition     = can(regex("^/[A-Za-z0-9_./-]*[A-Za-z0-9_.-]$", var.host_parameter_path))
    error_message = "host_parameter_path must start with a slash and not end with one."
  }
}

variable "game_dns_zone_name" {
  description = "Optional Route 53 public hosted zone containing game DNS records; empty keeps the DNS adapter disabled."
  type        = string
  default     = ""
}

variable "game_dns_suffix" {
  description = "Optional DNS suffix for world records, inside game_dns_zone_name (for example games.example.com)."
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

variable "fleet_root_volume_gib" {
  description = "Root volume of a launched host, which also holds the release cache and the worlds it restores; sized for a few worlds, not for save data."
  type        = number
  default     = 24
}

variable "control_plane_view_table_name" {
  description = "DynamoDB table that holds the operation records the workflows write (ADR-0105); infra/terraform-storage owns it."
  type        = string
  default     = "spawnpoint-control-plane-view"

  validation {
    condition     = can(regex("^[A-Za-z0-9_.-]{3,255}$", var.control_plane_view_table_name))
    error_message = "control_plane_view_table_name must be a valid DynamoDB table name."
  }
}
