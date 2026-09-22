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

variable "instance_type" {
  description = "Free-plan host now; promote to r8i-flex.large only after an explicit paid-plan decision."
  type        = string
  default     = "m7i-flex.large"

  validation {
    condition     = contains(["m7i-flex.large", "r8i-flex.large"], var.instance_type)
    error_message = "Use the measured free-plan shape or the reviewed 16 GiB upgrade; price any other type first."
  }
}

variable "data_volume_size_gib" {
  description = "Persistent world, release and session-data volume size."
  type        = number
  default     = 20

  validation {
    condition     = var.data_volume_size_gib >= 20
    error_message = "Do not shrink below the measured 20 GiB starting size. EBS volumes cannot shrink in place."
  }
}

variable "running_hours_alarm_hours" {
  description = "Consecutive running hours before the alarm fires. Keep it above the watchdog's session cap (8h at the default timings), or every long legitimate evening pages."
  type        = number
  default     = 10

  validation {
    condition     = var.running_hours_alarm_hours >= 2
    error_message = "An alarm under two hours fires during every ordinary session."
  }
}


variable "repository_url" {
  description = "Where a launched host checks this repository out from at first boot (ADR-0054, phase 12). Public, so the host needs no credential to read it."
  type        = string
  default     = "https://github.com/DrArzter/spawnpoint.git"

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
