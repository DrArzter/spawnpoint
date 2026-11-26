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
  default     = ["m7i-flex.*", "m7i.*", "r7i.*", "r8i-flex.*", "r8i.*", "c7i.*", "m7a.*", "r7a.*", "m6i.*", "r6i.*", "m6a.*", "r6a.*"]
}

variable "drain_grace_seconds" {
  description = "How long an empty launched host waits for a start to take it back before it is let go (ADR-0054)."
  type        = number
  default     = 600
}

variable "warm_host_retention_seconds" {
  description = "How long a launched host stopped for a warm world is kept after its last session before the drain terminates it (ADR-0054). 604800 is seven days."
  type        = number
  default     = 604800

  validation {
    condition     = var.warm_host_retention_seconds >= 0 && floor(var.warm_host_retention_seconds) == var.warm_host_retention_seconds
    error_message = "warm_host_retention_seconds must be a whole number of seconds, zero or more."
  }
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

variable "release_sweep_dry_run" {
  description = "When true, the release reconciler plans and logs its sweep and writes nothing (ADR-0080). Set false only after at least four weekly dry runs were read. CI sets it from the repository variable SPAWNPOINT_RELEASE_SWEEP_DRY_RUN; an unset variable means true."
  type        = bool
  default     = true
}

variable "session_volume" {
  description = "Whether a cold session on a launched host runs its world from its own EBS volume (ADR-0102, step 2). `disabled` starts and stops exactly as before. CI sets it from the repository variable SPAWNPOINT_SESSION_VOLUME; an unset variable means disabled."
  type        = string
  default     = "disabled"

  validation {
    condition     = contains(["disabled", "enabled"], var.session_volume)
    error_message = "session_volume must be disabled or enabled."
  }
}

variable "session_volume_size_gib" {
  description = "The size of a session volume in GiB (ADR-0102). A gp3 volume of this size is created for each cold session on a launched host while session_volume is enabled."
  type        = number
  default     = 30

  validation {
    condition     = var.session_volume_size_gib >= 1 && var.session_volume_size_gib <= 1024 && floor(var.session_volume_size_gib) == var.session_volume_size_gib
    error_message = "session_volume_size_gib must be a whole number from 1 to 1024."
  }
}

variable "spot" {
  description = "Whether a launched host whose sessions are all cold, of games that declare capabilities.spot, is asked for on Spot (ADR-0102, step 3). It takes effect only while session_volume is enabled. `disabled` launches exactly as before. CI sets it from the repository variable SPAWNPOINT_SPOT; an unset variable means disabled."
  type        = string
  default     = "disabled"

  validation {
    condition     = contains(["disabled", "enabled"], var.spot)
    error_message = "spot must be disabled or enabled."
  }
}

variable "spot_fault_test" {
  description = "Whether the AWS FIS experiment that sends one Spot interruption to an armed launched host exists (ADR-0102, step 7). It takes effect only while spot is enabled. CI sets it from the repository variable SPAWNPOINT_SPOT_FAULT_TEST; an unset variable means disabled."
  type        = string
  default     = "disabled"

  validation {
    condition     = contains(["disabled", "enabled"], var.spot_fault_test)
    error_message = "spot_fault_test must be disabled or enabled."
  }
}
