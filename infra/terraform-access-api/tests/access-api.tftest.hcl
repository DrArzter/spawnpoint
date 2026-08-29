mock_provider "aws" {
  override_during = plan

  override_data {
    target = data.aws_caller_identity.current
    values = { account_id = "123456789012" }
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
    target = data.aws_iam_policy_document.lambda_assume_role
    values = { json = "{}" }
  }

  override_data {
    target = data.aws_iam_policy_document.access_api
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
}

run "access_api_verifies_telegram_sessions_and_is_scoped" {
  command = plan

  variables {
    bootstrap_owner_telegram_id = "1780660807"
    telegram_bot_username       = "drarzterbot"
  }

  assert {
    condition     = contains(local.access_routes, "POST /auth/telegram")
    error_message = "The browser must have one endpoint that exchanges a verified Telegram login for a Spawnpoint session."
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
    condition     = aws_lambda_function.access_api.environment[0].variables.BOT_TOKEN_PARAMETER == "/spawnpoint/bot/token"
    error_message = "The verifier must read the existing bot token from SecureString rather than Terraform state."
  }
}
