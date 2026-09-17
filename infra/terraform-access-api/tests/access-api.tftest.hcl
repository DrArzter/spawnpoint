mock_provider "aws" {
  override_during = plan

  override_data {
    target = data.aws_caller_identity.current
    values = { account_id = "123456789012" }
  }

  override_data {
    target = data.aws_route53_zone.api
    values = { zone_id = "Z123456789" }
  }

  override_data {
    target = data.aws_dynamodb_table.access
    values = {
      name = "spawnpoint-access"
      arn  = "arn:aws:dynamodb:eu-central-1:123456789012:table/spawnpoint-access"
    }
  }

  override_data {
    target = data.aws_dynamodb_table.lifecycle
    values = {
      name = "spawnpoint-lifecycle-v2"
      arn  = "arn:aws:dynamodb:eu-central-1:123456789012:table/spawnpoint-lifecycle-v2"
    }
  }

  override_data {
    target = data.aws_s3_bucket.releases
    values = {
      id  = "spawnpoint-releases-123456789012"
      arn = "arn:aws:s3:::spawnpoint-releases-123456789012"
    }
  }

  override_data {
    target = data.aws_s3_bucket.backups
    values = {
      id  = "spawnpoint-backups-123456789012"
      arn = "arn:aws:s3:::spawnpoint-backups-123456789012"
    }
  }

  override_data {
    target = data.aws_iam_policy_document.lambda_assume_role
    values = { json = "{}" }
  }

  override_data {
    target = data.aws_iam_policy_document.access_api
    values = { json = "{}" }
  }

  override_data {
    target = data.aws_iam_policy_document.control_plane_subscriptions
    values = { json = "{}" }
  }

  override_data {
    target = data.aws_iam_policy_document.api_gateway_cloudwatch_assume
    values = { json = "{}" }
  }

  override_data {
    target = data.aws_iam_policy_document.api_gateway_cloudwatch
    values = { json = "{}" }
  }

  override_data {
    target = data.aws_iam_policy_document.world_lifecycle
    values = { json = "{}" }
  }

  override_data {
    target = data.aws_iam_policy_document.world_lifecycle_workflow_assume
    values = { json = "{}" }
  }

  override_data {
    target = data.aws_iam_policy_document.world_lifecycle_workflow
    values = { json = "{}" }
  }

}

mock_provider "archive" {
  override_during = plan

  override_data {
    target = data.archive_file.access_api
    values = {
      output_path         = "access-api.zip"
      output_base64sha256 = "test"
    }
  }

  override_data {
    target = data.archive_file.control_plane_subscriptions
    values = {
      output_path         = "control-plane-subscriptions.zip"
      output_base64sha256 = "test"
    }
  }


  override_data {
    target = data.archive_file.world_lifecycle
    values = {
      output_path         = "world-lifecycle.zip"
      output_base64sha256 = "test"
    }
  }
}

run "access_api_verifies_telegram_sessions_and_is_scoped" {
  command = plan

  variables {
    bootstrap_owner_telegram_id      = "1780660807"
    telegram_oidc_client_id          = "8521897198"
    panel_url                        = "https://spawnpoint.example.dev/"
    legacy_panel_url                 = "https://legacy.example.dev/"
    api_domain_name                  = "api.spawnpoint.example.dev"
    dns_zone_name                    = "example.dev"
    session_signing_secret_parameter = "/spawnpoint/auth/session-signing-secret"
  }

  assert {
    condition     = contains(local.access_routes, "POST /auth/telegram")
    error_message = "The browser must have one endpoint that exchanges a verified Telegram login for a Spawnpoint session."
  }

  assert {
    condition     = contains(local.access_routes, "POST /auth/refresh") && contains(local.access_routes, "POST /auth/logout")
    error_message = "Persistent browser login requires explicit refresh and logout endpoints."
  }

  assert {
    condition = toset(aws_apigatewayv2_api.access.cors_configuration[0].allow_origins) == toset([
      "https://spawnpoint.example.dev",
      "https://legacy.example.dev",
    ])
    error_message = "The hostname migration must accept both configured panel origins without embedding either in code."
  }

  assert {
    condition     = aws_apigatewayv2_api.access.cors_configuration[0].allow_credentials
    error_message = "The browser must be allowed to send the HttpOnly refresh cookie to the API."
  }

  assert {
    condition     = output.api_url == "https://api.spawnpoint.example.dev"
    error_message = "The web deployment must consume the repository-configured API hostname."
  }

  assert {
    condition     = aws_lambda_function.access_api.environment[0].variables.REFRESH_COOKIE_SAME_SITE == "Strict"
    error_message = "A same-site custom API hostname must use a Strict refresh cookie."
  }

  assert {
    condition     = alltrue([for route in aws_apigatewayv2_route.access : route.authorization_type == "NONE"])
    error_message = "The access Lambda must receive every route and verify the Spawnpoint session before protected dispatch."
  }

  assert {
    condition     = aws_lambda_function.access_api.environment[0].variables.ACCESS_TABLE_NAME == "spawnpoint-access"
    error_message = "The API must use the shared access directory."
  }

  assert {
    condition     = contains(local.access_routes, "GET /session") && contains(local.access_routes, "POST /access/request") && contains(local.access_routes, "GET /access/identities") && contains(local.access_routes, "POST /access/identities/{identityId}/role")
    error_message = "An authenticated Telegram visitor must be able to establish a session and request access."
  }

  assert {
    condition     = contains(local.access_routes, "GET /control-plane")
    error_message = "Approved identities need one read-only control-plane snapshot endpoint."
  }

  assert {
    condition     = contains(local.access_routes, "POST /control-plane/subscriptions")
    error_message = "Approved status readers need a short-lived ticket for projection invalidations."
  }

  assert {
    condition = (
      aws_apigatewayv2_api.control_plane.protocol_type == "WEBSOCKET" &&
      local.control_plane_websocket_routes == toset(["$connect", "$disconnect", "$default"]) &&
      length(aws_apigatewayv2_stage.control_plane.access_log_settings) == 1 &&
      !strcontains(aws_apigatewayv2_stage.control_plane.access_log_settings[0].format, "query")
    )
    error_message = "The dashboard push surface must be a bounded, auditable WebSocket API that never logs its one-time ticket."
  }

  assert {
    condition = (
      aws_api_gateway_account.current.cloudwatch_role_arn == aws_iam_role.api_gateway_cloudwatch.arn &&
      aws_iam_role_policy.api_gateway_cloudwatch.role == aws_iam_role.api_gateway_cloudwatch.id
    )
    error_message = "API Gateway must receive its account-level CloudWatch role before the logged WebSocket stage is created."
  }

  assert {
    condition = (
      aws_lambda_function.control_plane_subscriptions.environment[0].variables.CONTROL_PLANE_VIEW_TABLE == "spawnpoint-control-plane-view" &&
      contains(keys(aws_lambda_function.control_plane_subscriptions.environment[0].variables), "CONTROL_PLANE_WEBSOCKET_CALLBACK_URL")
    )
    error_message = "The subscription adapter must receive its table and callback endpoint from Terraform."
  }

  assert {
    condition = (
      jsondecode(aws_cloudwatch_event_rule.control_plane_projection_updated.event_pattern).source == ["spawnpoint.control-plane"] &&
      jsondecode(aws_cloudwatch_event_rule.control_plane_projection_updated.event_pattern)["detail-type"] == ["Projection Updated"]
    )
    error_message = "Only normalized projection invalidations may reach browser subscriptions."
  }

  assert {
    condition     = contains(local.access_routes, "POST /games/{gameId}/worlds/{worldId}/start") && contains(local.access_routes, "POST /games/{gameId}/worlds/{worldId}/stop")
    error_message = "Supported worlds need authenticated session-operation routes."
  }

  assert {
    condition     = contains(local.access_routes, "GET /access/roles") && contains(local.access_routes, "GET /me/subscriptions") && contains(local.access_routes, "PUT /me/subscriptions")
    error_message = "Roles and personal notification subscriptions must be backed by the access API."
  }

  assert {
    condition     = aws_lambda_function.access_api.environment[0].variables.LIFECYCLE_TABLE_NAME == "spawnpoint-lifecycle-v2" && aws_lambda_function.access_api.environment[0].variables.RELEASE_BUCKET == "spawnpoint-releases-123456789012"
    error_message = "The read model must use the established lifecycle and release stores."
  }

  assert {
    condition     = aws_lambda_function.access_api.environment[0].variables.CONTROL_PLANE_VIEW_TABLE == "spawnpoint-control-plane-view"
    error_message = "Dashboard reads must use the event-driven DynamoDB projection when it is fresh."
  }

  assert {
    condition     = strcontains(aws_lambda_function.access_api.environment[0].variables.OPERATION_STATE_MACHINES, "spawnpoint-start-server-v2") && strcontains(aws_lambda_function.access_api.environment[0].variables.OPERATION_STATE_MACHINES, "spawnpoint-stop-server-v2")
    error_message = "Panel session controls must use the fenced Lifecycle V2 wrappers."
  }

  assert {
    condition     = aws_lambda_function.access_api.environment[0].variables.BOT_TOKEN_PARAMETER == "/spawnpoint/bot/token"
    error_message = "The verifier must read the existing bot token from SecureString rather than Terraform state."
  }

  assert {
    condition     = aws_lambda_function.access_api.environment[0].variables.SESSION_SIGNING_SECRET_PARAMETER == "/spawnpoint/auth/session-signing-secret"
    error_message = "Spawnpoint access tokens must use their own provider-neutral signing secret."
  }

  assert {
    condition     = aws_lambda_function.access_api.environment[0].variables.TELEGRAM_OIDC_CLIENT_ID == "8521897198"
    error_message = "The OIDC verifier must receive the externally configured public BotFather client ID."
  }

  assert {
    condition     = aws_lambda_function.access_api.environment[0].variables.CONNECTION_HOST == "172.29.23.24"
    error_message = "The API receives a host only; the read model appends the selected game's port exactly once."
  }

  assert {
    condition = local.world_creation_resources == [
      "arn:aws:s3:::spawnpoint-releases-123456789012/worlds/*/world.json",
      "arn:aws:s3:::spawnpoint-releases-123456789012/worlds/*/generations/*/release.json",
    ]
    error_message = "Create world may write only the world descriptor and its first wipe's release state."
  }


  assert {
    condition = alltrue([
      contains(local.access_routes, "POST /games/{gameId}/worlds/{worldId}/archive"),
      contains(local.access_routes, "POST /games/{gameId}/worlds/{worldId}/wipe"),
      contains(local.access_routes, "POST /games/{gameId}/worlds/{worldId}/restore"),
      contains(local.access_routes, "POST /games/{gameId}/worlds/{worldId}/purge"),
    ])
    error_message = "Materialized worlds need explicit archive, wipe, restore and purge routes."
  }

  assert {
    condition     = !contains(local.access_routes, "POST /games/{gameId}/worlds/{worldId}/regenerate")
    error_message = "The player-facing name is wipe (ADR-0040); an alias route is surface nobody calls."
  }

  assert {
    condition     = aws_sfn_state_machine.world_lifecycle.type == "STANDARD"
    error_message = "World mutations must be durable workflows because a verified stop may take minutes."
  }
}

run "self_hosted_api_keeps_the_generated_endpoint_optional" {
  command = plan

  variables {
    bootstrap_owner_telegram_id      = "1780660807"
    panel_url                        = "https://panel.example.dev/"
    session_signing_secret_parameter = "/spawnpoint/auth/session-signing-secret"
  }

  assert {
    condition     = length(aws_acm_certificate.access_api) == 0 && length(aws_apigatewayv2_domain_name.access_api) == 0
    error_message = "A self-hosted installation must not need a domain or certificate."
  }

  assert {
    condition     = aws_lambda_function.access_api.environment[0].variables.REFRESH_COOKIE_SAME_SITE == "None"
    error_message = "The generated cross-site API endpoint needs a Secure SameSite=None refresh cookie."
  }
}
