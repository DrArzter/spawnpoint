locals {
  world_creation_resources = [
    "${data.aws_s3_bucket.releases.arn}/worlds/*/world.json",
    "${data.aws_s3_bucket.releases.arn}/worlds/*/generations/*/release.json",
  ]
}

resource "aws_iam_role" "access_api" {
  name               = "spawnpoint-access-api"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json
}

resource "aws_iam_role_policy_attachment" "access_api_logs" {
  role       = aws_iam_role.access_api.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

data "aws_iam_policy_document" "access_api" {
  statement {
    sid = "ReadAndManageAccessDirectory"
    actions = [
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:Query",
      "dynamodb:TransactWriteItems",
      "dynamodb:UpdateItem",
      # A ConditionCheck inside a transaction is authorised by its own action.
      "dynamodb:ConditionCheckItem",
      # Identity deletion (ADR-0071): plain deletes and Delete inside a transaction.
      "dynamodb:DeleteItem",
    ]
    resources = [
      data.aws_dynamodb_table.access.arn,
      "${data.aws_dynamodb_table.access.arn}/index/gsi1",
    ]
  }

  # OAuth credentials, email actions and player invitations have no index by
  # identity, so a deletion scans the table for them. The table only.
  statement {
    sid       = "ScanAccessDirectoryForIdentityDeletion"
    actions   = ["dynamodb:Scan"]
    resources = [data.aws_dynamodb_table.access.arn]
  }

  statement {
    sid       = "PublishInvitationEvents"
    actions   = ["events:PutEvents"]
    resources = ["arn:aws:events:${var.aws_region}:${data.aws_caller_identity.current.account_id}:event-bus/default"]
  }

  # The state of a release (live, retiring, retired) decides whether a wipe,
  # restore, promotion or new world may use it, and a writer of a world record
  # or pointer adds its holder first (ADR-0080). Release items and holders only:
  # the leading key keeps file items out of reach, and nothing here deletes.
  statement {
    sid       = "HoldReleaseState"
    actions   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem"]
    resources = [local.release_refs_table_arn]
    condition {
      test     = "ForAllValues:StringLike"
      variable = "dynamodb:LeadingKeys"
      values   = ["release#*"]
    }
  }

  # Retiring a release (ADR-0080) is one asynchronous call to one function, under
  # release.retire, which only the Owner role holds. No other Lambda is reachable.
  statement {
    sid       = "RequestReleaseRetirement"
    actions   = ["lambda:InvokeFunction"]
    resources = [local.release_retirement_function_arn]
  }

  statement {
    sid       = "ReadLifecycleState"
    actions   = ["dynamodb:GetItem"]
    resources = [data.aws_dynamodb_table.lifecycle.arn]
  }

  statement {
    sid       = "ReadControlPlaneViewAndIssueSubscriptionTickets"
    actions   = ["dynamodb:GetItem", "dynamodb:PutItem"]
    resources = [local.control_plane_view_table_arn]
  }

  statement {
    sid       = "DiscoverGameHosts"
    actions   = ["ec2:DescribeInstances"]
    resources = ["*"]
  }

  # Enumerate backups without being able to read one: the digest is in the key
  # and a listing reports the checksum algorithm, so no GetObject on a world
  # archive is needed to show — or to verify — an inventory.
  statement {
    sid       = "ListWorldBackups"
    actions   = ["s3:ListBucket"]
    resources = [data.aws_s3_bucket.backups.arn]

    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["worlds/*/archives/*", "worlds/*", "worlds/*/archives/"]
    }
  }

  # GetMetricData takes no resource, so the grant is the action and nothing else.
  # It reads what CloudWatch already publishes for free about the instance.
  statement {
    sid       = "ReadHostMetrics"
    actions   = ["cloudwatch:GetMetricData"]
    resources = ["*"]
  }

  statement {
    sid     = "ReadWorldReleasePointersAndPacks"
    actions = ["s3:GetObject"]
    resources = [
      "${data.aws_s3_bucket.releases.arn}/worlds/*",
      "${data.aws_s3_bucket.releases.arn}/presets/*",
      # Presigning a pack link signs this same permission, so the panel can hand
      # a player the files without ever holding a credential.
      "${data.aws_s3_bucket.releases.arn}/releases/*",
      # A pack or a mod of a content-addressed release is an object named by its digest.
      "${data.aws_s3_bucket.releases.arn}/objects/*",
    ]
  }

  # A world archive, for the backup.download permission only (ADR-0065): the
  # handler checks the key is the world's, records who asked, and presigns
  # this read for five minutes. Archives only; nothing else in the bucket.
  statement {
    sid       = "DownloadWorldArchives"
    actions   = ["s3:GetObject"]
    resources = ["${data.aws_s3_bucket.backups.arn}/worlds/*/archives/*.tar.zst"]
  }

  statement {
    sid       = "CreateWorldAndInitialReleasePointer"
    actions   = ["s3:PutObject"]
    resources = local.world_creation_resources
  }

  statement {
    sid       = "DiscoverWorldReleasePointers"
    actions   = ["s3:ListBucket"]
    resources = [data.aws_s3_bucket.releases.arn]

    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["worlds/*"]
    }
  }

  statement {
    sid     = "ReadRunningOperations"
    actions = ["states:ListExecutions"]
    resources = [
      for machine in local.operation_state_machines : machine.arn
      if contains(["start", "stop", "promote", "world"], machine.type)
    ]
  }

  # A running operation's input names its world, so a start blocks only that
  # world's operations, not every world's (ADR-0062).
  statement {
    sid     = "ReadRunningOperationWorlds"
    actions = ["states:DescribeExecution"]
    resources = [
      for machine in local.operation_state_machines : "${replace(machine.arn, ":stateMachine:", ":execution:")}:*"
      if contains(["start", "stop", "promote", "world"], machine.type)
    ]
  }

  # The progress of one operation: its current step is the newest state in the
  # execution history, and a nested start or stop is one more execution of the
  # fixed Lifecycle V2 machines or of the host machines beneath them. Read-only,
  # on executions of these machines only.
  statement {
    sid     = "ReadOperationHistory"
    actions = ["states:GetExecutionHistory"]
    resources = [
      for arn in local.operation_progress_machines : "${replace(arn, ":stateMachine:", ":execution:")}:*"
    ]
  }

  statement {
    sid     = "DescribeNestedHostExecutions"
    actions = ["states:DescribeExecution"]
    resources = [
      for arn in [local.start_host_state_machine_arn, local.stop_host_state_machine_arn] : "${replace(arn, ":stateMachine:", ":execution:")}:*"
    ]
  }

  # The host's own lines of a start. ListCommands takes no resource, so the grant
  # is the action alone: it finds the shell command a start sent to its host.
  # The output is read from one log group only, never written, and the API
  # filters it to an allow-list before it leaves (host-log.ts).
  statement {
    sid       = "FindHostStartCommand"
    actions   = ["ssm:ListCommands"]
    resources = ["*"]
  }

  # Identity avatars (ADR-0084): written, read through presigned links, and
  # deleted with the identity. Listing is needed to delete an identity's prefix.
  statement {
    sid       = "ManageIdentityAvatars"
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
    resources = ["${local.avatar_bucket_arn}/*"]
  }

  statement {
    sid       = "ListIdentityAvatars"
    actions   = ["s3:ListBucket"]
    resources = [local.avatar_bucket_arn]
  }

  statement {
    sid       = "ReadHostStartOutput"
    actions   = ["logs:GetLogEvents"]
    resources = ["${local.session_command_log_group_arn}:log-stream:*"]
  }

  statement {
    sid       = "ControlSupportedSession"
    actions   = ["states:StartExecution"]
    resources = [for machine in local.operation_state_machines : machine.arn if contains(["start", "stop", "world"], machine.type)]
  }

  # A fleet world's promotion (ADR-0078), under release.promote. The machine
  # itself composes only the fixed Lifecycle V2 start and stop.
  statement {
    sid       = "PromoteFleetWorld"
    actions   = ["states:StartExecution"]
    resources = [for machine in local.operation_state_machines : machine.arn if machine.type == "promote"]
  }

  statement {
    sid       = "RequestReleaseBuild"
    actions   = ["states:StartExecution"]
    resources = [local.build_release_arn]
  }
  statement {
    sid       = "ObserveReleaseBuild"
    actions   = ["states:DescribeExecution"]
    resources = ["${replace(local.build_release_arn, ":stateMachine:", ":execution:")}:*"]
  }
  statement {
    sid       = "FindRunningReleaseBuilds"
    actions   = ["states:ListExecutions"]
    resources = [local.build_release_arn]
  }
  statement {
    sid       = "KeepReleaseBuildAttempts"
    actions   = ["s3:GetObject", "s3:PutObject"]
    resources = ["${data.aws_s3_bucket.releases.arn}/preset-builds/*"]
  }
  # S3 returns 403, rather than NoSuchKey, without ListBucket. The build
  # adapter must distinguish an absent first attempt/manifest from denied IO.
  statement {
    sid       = "DistinguishUnpublishedBuilds"
    actions   = ["s3:ListBucket"]
    resources = [data.aws_s3_bucket.releases.arn]
  }

  statement {
    sid     = "ReadAuthenticationSecrets"
    actions = ["ssm:GetParameter"]
    resources = [
      "arn:aws:ssm:${var.aws_region}:${data.aws_caller_identity.current.account_id}:parameter${var.bot_token_parameter}",
      "arn:aws:ssm:${var.aws_region}:${data.aws_caller_identity.current.account_id}:parameter${var.session_signing_secret_parameter}",
    ]
  }

  dynamic "statement" {
    for_each = var.email_delivery_provider == "resend" ? [1] : []
    content {
      sid       = "ReadTransactionalEmailSecret"
      actions   = ["ssm:GetParameter"]
      resources = ["arn:aws:ssm:${var.aws_region}:${data.aws_caller_identity.current.account_id}:parameter${var.resend_api_key_parameter}"]
    }
  }

  dynamic "statement" {
    for_each = local.ses_enabled ? [1] : []
    content {
      sid       = "SendOnlyFromTheSenderIdentity"
      actions   = ["ses:SendEmail"]
      resources = [local.ses_identity_arn]
    }
  }
}

locals {
  # The function lives in ../terraform-operations; its name is the contract.
  release_retirement_function_name = "spawnpoint-release-retirement"
  release_retirement_function_arn  = "arn:aws:lambda:${var.aws_region}:${data.aws_caller_identity.current.account_id}:function:${local.release_retirement_function_name}"
}

resource "aws_iam_role_policy" "access_api" {
  name   = "spawnpoint-access-api"
  role   = aws_iam_role.access_api.id
  policy = data.aws_iam_policy_document.access_api.json
}

resource "aws_cloudwatch_log_group" "access_api" {
  name              = "/aws/lambda/spawnpoint-access-api"
  retention_in_days = 14
}

resource "aws_lambda_function" "access_api" {
  function_name    = "spawnpoint-access-api"
  role             = aws_iam_role.access_api.arn
  runtime          = "nodejs22.x"
  handler          = "index.handler"
  filename         = data.archive_file.access_api.output_path
  source_code_hash = data.archive_file.access_api.output_base64sha256
  timeout          = 10
  memory_size      = 256

  environment {
    variables = {
      ACCESS_TABLE_NAME                = data.aws_dynamodb_table.access.name
      BOOTSTRAP_OWNER_TELEGRAM_ID      = trimspace(var.bootstrap_owner_telegram_id)
      BOT_TOKEN_PARAMETER              = var.bot_token_parameter
      SESSION_SIGNING_SECRET_PARAMETER = var.session_signing_secret_parameter
      TELEGRAM_OIDC_CLIENT_ID          = var.telegram_oidc_client_id
      GOOGLE_OIDC_CLIENT_ID            = var.google_oidc_client_id
      PASSWORD_LOGIN_ENABLED           = var.password_login_enabled ? "true" : "false"
      PASSWORD_REGISTRATION_ENABLED    = var.password_registration_enabled ? "true" : "false"
      EMAIL_DELIVERY_PROVIDER          = var.email_delivery_provider
      RESEND_API_KEY_PARAMETER         = var.resend_api_key_parameter
      EMAIL_FROM                       = var.email_from
      EMAIL_REPLY_TO                   = var.email_reply_to
      PANEL_URL                        = trimsuffix(var.panel_url, "/")
      API_URL                          = local.custom_api_domain_enabled ? "https://${var.api_domain_name}" : aws_apigatewayv2_api.access.api_endpoint
      LEGACY_PANEL_URL                 = var.legacy_panel_url == null ? "" : trimsuffix(var.legacy_panel_url, "/")
      LIFECYCLE_TABLE_NAME             = data.aws_dynamodb_table.lifecycle.name
      CONTROL_PLANE_VIEW_TABLE         = var.control_plane_view_table_name
      CONTROL_PLANE_WEBSOCKET_URL      = "wss://${aws_apigatewayv2_api.control_plane.id}.execute-api.${var.aws_region}.amazonaws.com/${aws_apigatewayv2_stage.control_plane.name}"
      OPERATION_STATE_MACHINES         = jsonencode(local.operation_state_machines)
      RELEASE_BUCKET                   = data.aws_s3_bucket.releases.id
      RELEASE_REFS_TABLE               = var.release_refs_table_name
      BUILD_RELEASE_STATE_MACHINE_ARN  = local.build_release_arn
      RELEASE_RETIREMENT_FUNCTION_NAME = local.release_retirement_function_name
      BACKUP_BUCKET                    = data.aws_s3_bucket.backups.id
      AVATAR_BUCKET                    = local.avatar_bucket_name
      CONNECTION_HOST                  = var.connection_host
      CONSOLE_DOCUMENT_NAME            = aws_ssm_document.console.name
      WHITELIST_DOCUMENT_NAME          = aws_ssm_document.whitelist.name
      SPAWNPOINT_PLACEMENT             = var.placement
      SPAWNPOINT_LAUNCH                = var.launch
      SPAWNPOINT_APP_COMMIT            = var.app_commit
      GAME_DNS_SUFFIX                  = var.game_dns_suffix
      REFRESH_COOKIE_SAME_SITE         = local.custom_api_domain_enabled ? "Strict" : "None"
    }
  }

  depends_on = [aws_cloudwatch_log_group.access_api]
}

resource "aws_apigatewayv2_api" "access" {
  name          = "spawnpoint-access"
  protocol_type = "HTTP"

  cors_configuration {
    allow_origins = distinct(compact([
      trimsuffix(var.panel_url, "/"),
      var.legacy_panel_url == null ? null : trimsuffix(var.legacy_panel_url, "/"),
    ]))
    allow_headers     = ["authorization", "content-type"]
    allow_methods     = ["GET", "POST", "PUT", "OPTIONS"]
    allow_credentials = true
    max_age           = 3600
  }
}

resource "aws_apigatewayv2_integration" "access_api" {
  api_id                 = aws_apigatewayv2_api.access.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.access_api.invoke_arn
  payload_format_version = "2.0"
  timeout_milliseconds   = 10000
}

locals {
  access_routes = toset([
    "GET /.well-known/oauth-protected-resource",
    "GET /.well-known/oauth-protected-resource/mcp",
    "GET /.well-known/oauth-authorization-server",
    "POST /oauth/register",
    "GET /oauth/authorize",
    "POST /oauth/authorize",
    "POST /oauth/authorize/inspect",
    "POST /oauth/token",
    "POST /oauth/revoke",
    "POST /mcp",
    "GET /auth/providers",
    "POST /auth/telegram",
    "POST /auth/google",
    "POST /auth/password",
    "POST /auth/password/register",
    "POST /auth/email/verification",
    "POST /auth/email/verification/resend",
    "POST /auth/password/forgot",
    "POST /auth/password/reset",
    "POST /auth/refresh",
    "POST /auth/logout",
    "POST /auth/access-invitations/check",
    "GET /session",
    "GET /me",
    "GET /me/accounts",
    "POST /me/accounts/{provider}",
    "POST /me/password",
    "POST /me/password/change",
    "POST /me/avatar",
    "POST /me/avatar/delete",
    "GET /control-plane",
    "POST /control-plane/subscriptions",
    "GET /access/roles",
    "POST /access/roles",
    "POST /access/roles/{roleId}",
    "POST /access/roles/{roleId}/delete",
    "POST /access/defaults",
    "GET /access/invitations",
    "POST /access/invitations",
    "POST /access/invitations/redeem",
    "POST /access/invitations/proof",
    "POST /access/invitations/{invitationId}/revoke",
    "GET /me/subscriptions",
    "PUT /me/subscriptions",
    "GET /me/appearance",
    "PUT /me/appearance",
    "GET /invitations/recipients",
    "POST /games/{gameId}/worlds/{worldId}/start",
    "POST /games/{gameId}/worlds/{worldId}/stop",
    "POST /games/{gameId}/worlds/{worldId}/invitations",
    "GET /games/{gameId}/worlds/{worldId}/invitations",
    "GET /games/{gameId}/worlds/{worldId}/pack",
    "GET /games/{gameId}/worlds/{worldId}/backups",
    "POST /games/{gameId}/worlds/{worldId}/backups/download",
    "GET /games/{gameId}/worlds/{worldId}/console",
    "GET /games/{gameId}/worlds/{worldId}/metrics",
    "POST /games/{gameId}/worlds/{worldId}/console",
    "GET /hosts/{instanceId}/metrics",
    "GET /games/{gameId}/presets/{presetId}/releases/{version}",
    "GET /games/{gameId}/presets/{presetId}/releases/{version}/mods/{sha256}",
    "GET /games/{gameId}/presets/{presetId}/releases/{version}/packs/{pack}",
    "GET /games/{gameId}/presets/{presetId}/releases/{version}/diff",
    "POST /games/{gameId}/presets/{presetId}/releases/{version}/retire",
    "POST /games/{gameId}/presets/{presetId}/worlds",
    "POST /games/{gameId}/presets/{presetId}/builds",
    "PUT /games/{gameId}/worlds/{worldId}/settings",
    "PUT /games/{gameId}/worlds/{worldId}/game-settings",
    "GET /games/{gameId}/worlds/{worldId}/whitelist",
    "PUT /games/{gameId}/worlds/{worldId}/whitelist",
    "POST /games/{gameId}/worlds/{worldId}/archive",
    "POST /games/{gameId}/worlds/{worldId}/wipe",
    "POST /games/{gameId}/worlds/{worldId}/restore",
    "POST /games/{gameId}/worlds/{worldId}/purge",
    "POST /games/{gameId}/worlds/{worldId}/promote",
    "GET /games/{gameId}/worlds/{worldId}/operations/{operationId}",
    "POST /access/request",
    "GET /access/candidates",
    "GET /access/identities",
    "POST /access/candidates/{platform}/{platformUserId}/approve",
    "POST /access/candidates/{platform}/{platformUserId}/dismiss",
    "POST /access/identities/{identityId}/role",
    "POST /access/identities/{identityId}/delete",
  ])
}

resource "aws_apigatewayv2_route" "access" {
  for_each = local.access_routes

  api_id             = aws_apigatewayv2_api.access.id
  route_key          = each.value
  target             = "integrations/${aws_apigatewayv2_integration.access_api.id}"
  authorization_type = "NONE"
}

resource "aws_cloudwatch_log_group" "access_api_http_access" {
  name              = "/aws/apigateway/spawnpoint-access-api"
  retention_in_days = 14
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.access.id
  name        = "$default"
  auto_deploy = true

  # Records requests refused or throttled before the Lambda. No path or query
  # string: OAuth and sign-in requests can carry tokens there.
  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.access_api_http_access.arn
    format = jsonencode({
      requestId               = "$context.requestId"
      sourceIp                = "$context.identity.sourceIp"
      requestTime             = "$context.requestTime"
      routeKey                = "$context.routeKey"
      status                  = "$context.status"
      integrationErrorMessage = "$context.integrationErrorMessage"
    })
  }

  # API Gateway validates every route_settings key during UpdateStage. Keep
  # the stage update behind route creation so a new throttled route cannot
  # race the stage and fail the apply with Route not found.
  depends_on = [
    aws_apigatewayv2_route.access,
    aws_api_gateway_account.current,
  ]

  dynamic "route_settings" {
    for_each = toset([
      "POST /auth/password",
      "POST /auth/password/register",
      "POST /auth/email/verification",
      "POST /auth/email/verification/resend",
      "POST /auth/password/forgot",
      "POST /auth/password/reset",
      "POST /oauth/register",
      "POST /oauth/token",
      "POST /oauth/revoke",
    ])
    content {
      route_key              = route_settings.value
      throttling_burst_limit = var.password_auth_throttling_burst_limit
      throttling_rate_limit  = var.password_auth_throttling_rate_limit
    }
  }
}

resource "aws_lambda_permission" "access_api" {
  statement_id  = "AllowApiGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.access_api.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.access.execution_arn}/*/*"
}

resource "aws_acm_certificate" "access_api" {
  count             = local.custom_api_domain_enabled ? 1 : 0
  domain_name       = var.api_domain_name
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_route53_record" "access_api_certificate_validation" {
  count   = local.custom_api_domain_enabled ? 1 : 0
  zone_id = data.aws_route53_zone.api[0].zone_id
  name    = tolist(aws_acm_certificate.access_api[0].domain_validation_options)[0].resource_record_name
  type    = tolist(aws_acm_certificate.access_api[0].domain_validation_options)[0].resource_record_type
  records = [tolist(aws_acm_certificate.access_api[0].domain_validation_options)[0].resource_record_value]
  ttl     = 60
}

resource "aws_acm_certificate_validation" "access_api" {
  count                   = local.custom_api_domain_enabled ? 1 : 0
  certificate_arn         = aws_acm_certificate.access_api[0].arn
  validation_record_fqdns = [aws_route53_record.access_api_certificate_validation[0].fqdn]
}

resource "aws_apigatewayv2_domain_name" "access_api" {
  count       = local.custom_api_domain_enabled ? 1 : 0
  domain_name = var.api_domain_name

  domain_name_configuration {
    certificate_arn = aws_acm_certificate_validation.access_api[0].certificate_arn
    endpoint_type   = "REGIONAL"
    security_policy = "TLS_1_2"
  }
}

resource "aws_apigatewayv2_api_mapping" "access_api" {
  count       = local.custom_api_domain_enabled ? 1 : 0
  api_id      = aws_apigatewayv2_api.access.id
  domain_name = aws_apigatewayv2_domain_name.access_api[0].id
  stage       = aws_apigatewayv2_stage.default.id
}

resource "aws_route53_record" "access_api" {
  count   = local.custom_api_domain_enabled ? 1 : 0
  zone_id = data.aws_route53_zone.api[0].zone_id
  name    = var.api_domain_name
  type    = "A"

  alias {
    name                   = aws_apigatewayv2_domain_name.access_api[0].domain_name_configuration[0].target_domain_name
    zone_id                = aws_apigatewayv2_domain_name.access_api[0].domain_name_configuration[0].hosted_zone_id
    evaluate_target_health = false
  }
}
