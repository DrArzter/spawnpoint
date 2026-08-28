output "api_url" {
  description = "JWT-protected access-management API base URL."
  value       = aws_apigatewayv2_api.access.api_endpoint
}

output "cognito_user_pool_id" {
  description = "Cognito user pool issuing the API JWTs."
  value       = aws_cognito_user_pool.access.id
}

output "cognito_client_id" {
  description = "Public SPA app-client identifier used with Authorization Code + PKCE."
  value       = aws_cognito_user_pool_client.panel.id
}

output "cognito_domain" {
  description = "Cognito authorization-server domain."
  value       = "https://${aws_cognito_user_pool_domain.access.domain}.auth.${var.aws_region}.amazoncognito.com"
}

output "google_redirect_uri" {
  description = "Authorized redirect URI to configure on the Google OAuth web client."
  value       = "https://${aws_cognito_user_pool_domain.access.domain}.auth.${var.aws_region}.amazoncognito.com/oauth2/idpresponse"
}
