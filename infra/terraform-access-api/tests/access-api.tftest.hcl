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

run "access_api_is_jwt_only_and_scoped_to_the_access_table" {
  command = plan

  variables {
    bootstrap_owner_email = "owner@example.com"
  }

  assert {
    condition     = aws_apigatewayv2_authorizer.cognito.authorizer_type == "JWT"
    error_message = "The browser API must reject requests without a Cognito JWT before Lambda."
  }

  assert {
    condition     = alltrue([for route in aws_apigatewayv2_route.access : route.authorization_type == "JWT"])
    error_message = "No access-management route may accidentally become public."
  }

  assert {
    condition     = aws_lambda_function.access_api.environment[0].variables.ACCESS_TABLE_NAME == "spawnpoint-access"
    error_message = "The API must use the shared access directory."
  }

  assert {
    condition     = aws_cognito_user_pool.access.deletion_protection == "ACTIVE" && aws_cognito_user_pool.access.admin_create_user_config[0].allow_admin_create_user_only
    error_message = "The user pool must be protected and must not allow password self-sign-up."
  }

  assert {
    condition     = aws_cognito_user_pool_client.panel.allowed_oauth_flows == toset(["code"]) && !aws_cognito_user_pool_client.panel.generate_secret
    error_message = "The SPA uses Authorization Code + PKCE with a public client, never a browser-held secret."
  }
}
