output "api_url" {
  description = "Telegram-session-protected access-management API base URL."
  value       = local.custom_api_domain_enabled ? "https://${var.api_domain_name}" : aws_apigatewayv2_api.access.api_endpoint
}

output "telegram_oidc_client_id" {
  description = "Public BotFather Client ID consumed by the browser Telegram Login library."
  value       = var.telegram_oidc_client_id
}

output "control_plane_websocket_url" {
  description = "Ticket-protected WebSocket endpoint carrying control-plane projection invalidations."
  value       = "wss://${aws_apigatewayv2_api.control_plane.id}.execute-api.${var.aws_region}.amazonaws.com/${aws_apigatewayv2_stage.control_plane.name}"
}
