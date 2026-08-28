output "api_url" {
  description = "Telegram-session-protected access-management API base URL."
  value       = aws_apigatewayv2_api.access.api_endpoint
}

output "telegram_bot_username" {
  description = "Bot username embedded by the web build in the official Telegram Login Widget."
  value       = var.telegram_bot_username
}
