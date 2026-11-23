output "api_url" {
  description = "Telegram-session-protected access-management API base URL."
  value       = local.custom_api_domain_enabled ? "https://${var.api_domain_name}" : aws_apigatewayv2_api.access.api_endpoint
}

output "telegram_oidc_client_id" {
  description = "Public BotFather Client ID consumed by the browser Telegram Login library."
  value       = var.telegram_oidc_client_id
}

output "google_oidc_client_id" {
  description = "Public Google OAuth client ID consumed by the browser Google Identity Services library; empty when Google sign-in is off."
  value       = var.google_oidc_client_id
}

output "control_plane_websocket_url" {
  description = "Ticket-protected WebSocket endpoint carrying control-plane projection invalidations."
  value       = "wss://${aws_apigatewayv2_api.control_plane.id}.execute-api.${var.aws_region}.amazonaws.com/${aws_apigatewayv2_stage.control_plane.name}"
}

output "ses_dkim_records" {
  description = "DKIM CNAME records the owner adds by hand when the SES sender's domain is outside dns_zone_name; empty otherwise."
  value = local.ses_enabled && !local.ses_dkim_in_zone ? [
    for token in aws_sesv2_email_identity.sender[0].dkim_signing_attributes[0].tokens :
    { name = "${token}._domainkey.${local.ses_sender_domain}", type = "CNAME", value = "${token}.dkim.amazonses.com" }
  ] : []
}
