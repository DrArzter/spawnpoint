variable "aws_region" {
  description = "Region containing the Spawnpoint control plane."
  type        = string
  default     = "eu-central-1"
}

variable "aws_profile" {
  description = "Shared AWS CLI profile used locally; never a credential value."
  type        = string
  default     = "spawnpoint"
}

variable "control_plane_view_table_name" {
  description = "DynamoDB table containing the rebuildable dashboard projection."
  type        = string
  default     = "spawnpoint-control-plane-view"

  validation {
    condition     = can(regex("^[A-Za-z0-9_.-]{3,255}$", var.control_plane_view_table_name))
    error_message = "control_plane_view_table_name must be a valid DynamoDB table name."
  }
}

variable "panel_url" {
  description = "HTTPS origin hosting the Telegram Login Widget and calling the access API."
  type        = string

  validation {
    condition     = can(regex("^https://[^/]+/?$", var.panel_url))
    error_message = "panel_url must be one HTTPS origin with no path, query or fragment."
  }
}

variable "legacy_panel_url" {
  description = "Optional previous panel origin kept temporarily during a zero-downtime hostname migration."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition     = var.legacy_panel_url == null || can(regex("^https://[^/]+/?$", var.legacy_panel_url))
    error_message = "legacy_panel_url must be null or one HTTPS origin with no path, query or fragment."
  }
}

variable "api_domain_name" {
  description = "Optional HTTPS hostname for the access API. Set together with dns_zone_name; null keeps the execute-api endpoint for self-hosting."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition     = var.api_domain_name == null || var.api_domain_name == "" || can(regex("^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$", var.api_domain_name))
    error_message = "api_domain_name must be null or a hostname without scheme, path, query or fragment."
  }
}

variable "dns_zone_name" {
  description = "Optional existing Route53 public zone containing api_domain_name. Set together with api_domain_name."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition     = var.dns_zone_name == null || var.dns_zone_name == "" || can(regex("^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$", var.dns_zone_name))
    error_message = "dns_zone_name must be null or a DNS zone name without scheme or path."
  }
}

check "custom_api_domain_configuration" {
  assert {
    condition     = (var.api_domain_name != null && var.api_domain_name != "") == (var.dns_zone_name != null && var.dns_zone_name != "")
    error_message = "api_domain_name and dns_zone_name must either both be set or both be null."
  }

  assert {
    condition = (
      var.api_domain_name == null || var.api_domain_name == "" ||
      var.dns_zone_name == null || var.dns_zone_name == "" ||
      var.api_domain_name == var.dns_zone_name || endswith(var.api_domain_name, ".${var.dns_zone_name}")
    )
    error_message = "api_domain_name must be inside dns_zone_name."
  }
}

variable "bootstrap_owner_telegram_id" {
  description = "Exact Telegram user id allowed to atomically claim the first Owner."
  type        = string
  sensitive   = true

  validation {
    condition     = can(regex("^[1-9][0-9]{4,19}$", var.bootstrap_owner_telegram_id))
    error_message = "bootstrap_owner_telegram_id must be an explicitly selected numeric Telegram user id."
  }
}

variable "telegram_oidc_client_id" {
  description = "Public Telegram Login OIDC client ID issued by BotFather; empty keeps browser OIDC disabled for self-hosted deployments."
  type        = string
  default     = ""

  validation {
    condition     = var.telegram_oidc_client_id == "" || can(regex("^[1-9][0-9]+$", var.telegram_oidc_client_id))
    error_message = "telegram_oidc_client_id must be empty or the numeric Client ID issued by BotFather."
  }
}

variable "bot_token_parameter" {
  description = "Existing SecureString parameter containing the Telegram bot token used to verify login signatures."
  type        = string
  default     = "/spawnpoint/bot/token"
}

variable "session_signing_secret_parameter" {
  description = "Existing SecureString parameter containing the provider-neutral Spawnpoint access-token signing secret."
  type        = string
}

variable "connection_host" {
  description = "Host part of every world's address — the overlay IPv4 address this deployment publishes. Each game's port completes it."
  type        = string
  default     = "172.29.23.24"

  validation {
    condition     = can(cidrhost("${var.connection_host}/32", 0))
    error_message = "connection_host must be an IPv4 address without a port; the game catalog appends each game's port."
  }
}

variable "placement" {
  description = "How a start chooses its host (ADR-0054): `single` starts the configured instance as before; `shared` places the session on a registered host with room, which today is that same instance with other games beside it."
  type        = string
  default     = "single"

  validation {
    condition     = contains(["single", "shared"], var.placement)
    error_message = "placement must be single or shared."
  }
}

variable "launch" {
  description = "Whether a session nothing has room for may launch a host from the fleet template (ADR-0054, phase 12). `disabled` refuses and cancels the session; `enabled` creates an instant EC2 Fleet for the footprint's requirements."
  type        = string
  default     = "disabled"

  validation {
    condition     = contains(["disabled", "enabled"], var.launch)
    error_message = "launch must be disabled or enabled."
  }
}

variable "app_commit" {
  description = "The commit of this repository a launched host checks out into its app directory, carried as the instance's AppCommit tag. `main` follows the branch; the deploy pipeline should pin the tested commit."
  type        = string
  default     = "main"

  validation {
    condition     = can(regex("^([0-9a-f]{40}|[A-Za-z0-9._/-]{1,120})$", var.app_commit))
    error_message = "app_commit must be a commit hash or a ref name."
  }
}
