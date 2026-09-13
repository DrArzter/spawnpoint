output "api_url" {
  description = "Telegram-session-protected access-management API base URL."
  value       = local.custom_api_domain_enabled ? "https://${var.api_domain_name}" : aws_apigatewayv2_api.access.api_endpoint
}

output "telegram_oidc_client_id" {
  description = "Public BotFather Client ID consumed by the browser Telegram Login library."
  value       = var.telegram_oidc_client_id
}
