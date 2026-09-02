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

variable "panel_url" {
  description = "HTTPS origin hosting the Telegram Login Widget and calling the access API."
  type        = string
  default     = "https://dwk99t8cin0cf.cloudfront.net/"
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

variable "telegram_bot_username" {
  description = "Bot username registered for Web Login in BotFather, without the leading @."
  type        = string
  default     = "drarzterbot"

  validation {
    condition     = can(regex("^[A-Za-z][A-Za-z0-9_]{3,30}bot$", var.telegram_bot_username))
    error_message = "telegram_bot_username must be a valid Telegram bot username without @."
  }
}

variable "bot_token_parameter" {
  description = "Existing SecureString parameter containing the Telegram bot token used to verify login signatures."
  type        = string
  default     = "/spawnpoint/bot/token"
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
