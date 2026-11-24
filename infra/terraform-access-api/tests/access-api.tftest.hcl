mock_provider "aws" {
  override_during = plan

  override_data {
    target = data.aws_caller_identity.current
    values = { account_id = "123456789012" }
  }

  override_data {
    target = data.aws_sns_topic.alerts
    values = { arn = "arn:aws:sns:eu-central-1:123456789012:spawnpoint-alert" }
  }

  override_data {
    target = data.aws_route53_zone.api
    values = { zone_id = "Z123456789" }
  }

  override_data {
    target = data.aws_route53_zone.email
    values = { zone_id = "Z123456789" }
  }

  # DKIM tokens exist only after apply; fixed ones let the plan-time run name
  # the records.
  override_resource {
    target = aws_sesv2_email_identity.sender
    values = {
      dkim_signing_attributes = { tokens = ["tokena", "tokenb", "tokenc"] }
    }
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
    target = data.aws_iam_policy_document.access_api_console
    values = { json = "{}" }
  }

  override_data {
    target = data.aws_instance.configured_host
    values = { arn = "arn:aws:ec2:eu-central-1:123456789012:instance/i-0123456789abcdef0" }
  }

  # The console's permission names the document by ARN, known only after
  # apply; a fixed one lets the plan-time run read the statements.
  override_resource {
    target = aws_ssm_document.console
    values = { arn = "arn:aws:ssm:eu-central-1:123456789012:document/spawnpoint-console" }
  }

  override_resource {
    target = aws_ssm_document.whitelist
    values = { arn = "arn:aws:ssm:eu-central-1:123456789012:document/spawnpoint-whitelist" }
  }

  override_resource {
    target = aws_ssm_document.world_log
    values = { arn = "arn:aws:ssm:eu-central-1:123456789012:document/spawnpoint-world-log" }
  }

  override_resource {
    target = aws_lambda_function.assistant
    values = { arn = "arn:aws:lambda:eu-central-1:123456789012:function:spawnpoint-assistant" }
  }

  override_data {
    target = data.aws_iam_policy_document.control_plane_subscriptions
    values = { json = "{}" }
  }

  override_data {
    target = data.aws_iam_policy_document.assistant
    values = { json = "{}" }
  }

  override_data {
    target = data.aws_iam_policy_document.api_gateway_cloudwatch_assume
    values = { json = "{}" }
  }

  # The account setting names the role by ARN, which a mocked role only has
  # after apply; a fixed one lets the plan-time run see the link.
  override_resource {
    target = aws_iam_role.api_gateway_cloudwatch
    values = {
      arn = "arn:aws:iam::123456789012:role/spawnpoint-apigateway-cloudwatch"
      id  = "spawnpoint-apigateway-cloudwatch"
    }
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
    google_oidc_client_id            = "1234567890-abc123def456.apps.googleusercontent.com"
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
    condition     = contains(local.access_routes, "POST /games/{gameId}/worlds/{worldId}/console") && contains(local.access_routes, "GET /games/{gameId}/worlds/{worldId}/console")
    error_message = "The console gateway sends a command and reads the recorded results (ADR-0063)."
  }

  assert {
    condition = alltrue([
      jsondecode(aws_ssm_document.console.content).parameters.worldId.allowedPattern == "^[a-z0-9][a-z0-9-]{0,31}$",
      jsondecode(aws_ssm_document.console.content).parameters.slot.allowedPattern == "^([0-9]{1,3})?$",
      jsondecode(aws_ssm_document.console.content).parameters.command.allowedPattern == "^[A-Za-z0-9+/]{1,700}[A-Za-z0-9+/]{0,700}={0,2}$",
    ])
    error_message = "Every value the console document puts in a shell is held to a pattern that admits no quote, space or metacharacter."
  }

  assert {
    condition = alltrue([
      jsondecode(aws_ssm_document.whitelist.content).parameters.worldId.allowedPattern == "^[a-z0-9][a-z0-9-]{0,31}$",
      jsondecode(aws_ssm_document.whitelist.content).parameters.slot.allowedPattern == "^([0-9]{1,3})?$",
      keys(jsondecode(aws_ssm_document.whitelist.content).parameters) == ["slot", "worldId"],
      aws_lambda_function.access_api.environment[0].variables.WHITELIST_DOCUMENT_NAME == "spawnpoint-whitelist",
    ])
    error_message = "The whitelist document names only a world and a slot; the names come from the world's record on the host."
  }

  # SSM compiles allowedPattern as a Go regular expression, as Terraform does.
  # Go refuses a repeat count above 1000, and SSM refused {1,1400} only at apply.
  assert {
    condition = alltrue(flatten([
      for document in [aws_ssm_document.console, aws_ssm_document.whitelist] : [
        for parameter in values(jsondecode(document.content).parameters) : can(regexall(parameter.allowedPattern, ""))
      ]
    ]))
    error_message = "Every SSM document pattern must compile as a Go regular expression, which SSM checks only at apply."
  }

  assert {
    condition = alltrue([
      for statement in data.aws_iam_policy_document.access_api_console.statement :
      !contains(statement.actions, "ssm:SendCommand") || (
        !anytrue([for resource in statement.resources : strcontains(resource, "AWS-RunShellScript")])
      )
    ])
    error_message = "The API may send the console document only, never the generic shell document."
  }

  assert {
    condition = anytrue([
      for statement in data.aws_iam_policy_document.access_api_console.statement :
      statement.sid == "SendOnlySpawnpointDocumentsToLaunchedHosts" && anytrue([
        for condition in statement.condition : condition.variable == "ssm:resourceTag/ManagedBy" && contains(condition.values, "spawnpoint-fleet")
      ])
    ])
    error_message = "A launched host is admitted to the console by its fleet tag."
  }

  assert {
    condition = anytrue([
      for statement in data.aws_iam_policy_document.access_api.statement : statement.sid == "DownloadWorldArchives"
      ]) && alltrue([
      for statement in data.aws_iam_policy_document.access_api.statement :
      statement.actions == toset(["s3:GetObject"]) &&
      statement.resources == toset(["arn:aws:s3:::spawnpoint-backups-123456789012/worlds/*/archives/*.tar.zst"])
      if anytrue([for resource in statement.resources : startswith(resource, "arn:aws:s3:::spawnpoint-backups-123456789012/")])
    ])
    error_message = "The API reads world archives for backup.download and nothing else in the backup bucket, and writes none."
  }

  assert {
    condition = contains(local.access_routes, "POST /access/identities/{identityId}/delete") && anytrue([
      for statement in data.aws_iam_policy_document.access_api.statement :
      statement.sid == "ReadAndManageAccessDirectory" && contains(statement.actions, "dynamodb:DeleteItem") && contains(statement.actions, "dynamodb:ConditionCheckItem")
      ]) && alltrue([
      for statement in data.aws_iam_policy_document.access_api.statement :
      statement.resources == toset(["arn:aws:dynamodb:eu-central-1:123456789012:table/spawnpoint-access"])
      if contains(statement.actions, "dynamodb:Scan")
    ])
    error_message = "Identity deletion is routed, may delete and condition-check access items, and scans the access table only, never an index or another table."
  }

  assert {
    condition     = aws_lambda_function.access_api.environment[0].variables.CONSOLE_DOCUMENT_NAME == "spawnpoint-console"
    error_message = "The API names the console document it may send."
  }

  assert {
    condition = alltrue([
      one([
        for statement in data.aws_iam_policy_document.world_lifecycle.statement : statement.resources
        if statement.sid == "VerifyReleaseBeforeRestore"
      ]) == toset(["arn:aws:s3:::spawnpoint-releases-123456789012/releases/*/manifest.json"]),
      one([
        for statement in data.aws_iam_policy_document.world_lifecycle.statement : statement.actions
        if statement.sid == "DistinguishMissingReleaseManifest"
      ]) == toset(["s3:ListBucket"]),
    ])
    error_message = "The world lifecycle may verify release manifests before restoring, without reading arbitrary release objects."
  }

  assert {
    condition = alltrue([
      one([for statement in data.aws_iam_policy_document.world_lifecycle.statement : statement.actions if statement.sid == "HoldReleaseState"]) == toset(["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem"]),
      one([for statement in data.aws_iam_policy_document.world_lifecycle.statement : statement.resources if statement.sid == "HoldReleaseState"]) == toset(["arn:aws:dynamodb:eu-central-1:123456789012:table/spawnpoint-release-refs"]),
      one(one([for statement in data.aws_iam_policy_document.world_lifecycle.statement : statement.condition if statement.sid == "HoldReleaseState"])).test == "ForAllValues:StringLike",
      one(one([for statement in data.aws_iam_policy_document.world_lifecycle.statement : statement.condition if statement.sid == "HoldReleaseState"])).variable == "dynamodb:LeadingKeys",
      toset(one(one([for statement in data.aws_iam_policy_document.world_lifecycle.statement : statement.condition if statement.sid == "HoldReleaseState"])).values) == toset(["release#*"]),
      one([for statement in data.aws_iam_policy_document.access_api.statement : statement.actions if statement.sid == "HoldReleaseState"]) == toset(["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem"]),
      one([for statement in data.aws_iam_policy_document.access_api.statement : statement.resources if statement.sid == "HoldReleaseState"]) == toset(["arn:aws:dynamodb:eu-central-1:123456789012:table/spawnpoint-release-refs"]),
      one(one([for statement in data.aws_iam_policy_document.access_api.statement : statement.condition if statement.sid == "HoldReleaseState"])).test == "ForAllValues:StringLike",
      one(one([for statement in data.aws_iam_policy_document.access_api.statement : statement.condition if statement.sid == "HoldReleaseState"])).variable == "dynamodb:LeadingKeys",
      toset(one(one([for statement in data.aws_iam_policy_document.access_api.statement : statement.condition if statement.sid == "HoldReleaseState"])).values) == toset(["release#*"]),
    ])
    error_message = "The API and the world lifecycle get, put and update release items and holders (leading key release#*) so a writer holds a release before it names it, and nothing else in the table."
  }

  # No statement may delete, batch, scan or query the table, and every write on
  # it carries the leading-key condition: a file# item cannot be written.
  assert {
    condition = alltrue([
      for action in flatten([for statement in concat(tolist(data.aws_iam_policy_document.world_lifecycle.statement), tolist(data.aws_iam_policy_document.access_api.statement)) : tolist(statement.actions) if contains(statement.resources, "arn:aws:dynamodb:eu-central-1:123456789012:table/spawnpoint-release-refs")]) :
      !startswith(action, "dynamodb:Delete") && !startswith(action, "dynamodb:Batch") && !startswith(action, "dynamodb:Scan") && !startswith(action, "dynamodb:Query")
    ])
    error_message = "No role of this root may delete from the reference table or read it by scan or query."
  }

  assert {
    condition = alltrue([
      for statement in concat(tolist(data.aws_iam_policy_document.world_lifecycle.statement), tolist(data.aws_iam_policy_document.access_api.statement)) :
      length(statement.condition) == 1 && one(statement.condition).variable == "dynamodb:LeadingKeys" && toset(one(statement.condition).values) == toset(["release#*"])
      if contains(statement.resources, "arn:aws:dynamodb:eu-central-1:123456789012:table/spawnpoint-release-refs")
    ])
    error_message = "Every statement on the reference table is limited to release# leading keys, so no role here writes a file# item."
  }

  assert {
    condition = contains(one([
      for statement in data.aws_iam_policy_document.access_api.statement : statement.resources
      if statement.sid == "ReadWorldReleasePointersAndPacks"
    ]), "arn:aws:s3:::spawnpoint-releases-123456789012/objects/*")
    error_message = "The API presigns the objects of a content-addressed release, so it reads objects/."
  }

  assert {
    condition = alltrue([
      contains(local.access_routes, "POST /games/{gameId}/worlds/{worldId}/promote"),
      one([
        for statement in data.aws_iam_policy_document.access_api.statement : statement.resources
        if statement.sid == "PromoteFleetWorld"
      ]) == toset(["arn:aws:states:eu-central-1:123456789012:stateMachine:spawnpoint-promote-release"]),
    ])
    error_message = "The API may start the promote-release machine and no other machine through the promotion grant."
  }

  assert {
    condition = alltrue([
      for statement in data.aws_iam_policy_document.access_api.statement :
      statement.actions == toset(["dynamodb:GetItem"]) && statement.resources == toset(["arn:aws:dynamodb:eu-central-1:123456789012:table/spawnpoint-lifecycle-v2"])
      if statement.sid == "ReadLifecycleState"
    ])
    error_message = "The API reads a world's session history (sessions# items) from the lifecycle table with GetItem only; the coordinator writes it."
  }

  assert {
    condition = alltrue([
      for sid in ["ReadRunningOperations", "ReadRunningOperationWorlds"] :
      length([for statement in data.aws_iam_policy_document.access_api.statement : statement if statement.sid == sid && strcontains(join(",", statement.resources), "spawnpoint-start-server-v2")]) == 1
    ])
    error_message = "Earlier sessions of a world are read from the finished start and stop executions: both may be listed and described, read-only (ADR-0015)."
  }

  assert {
    condition = alltrue([
      contains(local.access_routes, "GET /games/{gameId}/worlds/{worldId}/operations/{operationId}"),
      one([for statement in data.aws_iam_policy_document.access_api.statement : statement.actions if statement.sid == "ReadOperationHistory"]) == toset(["states:GetExecutionHistory"]),
      one([for statement in data.aws_iam_policy_document.access_api.statement : statement.resources if statement.sid == "ReadOperationHistory"]) == toset([
        for name in ["start-server-v2", "stop-server-v2", "promote-release", "world-lifecycle", "start-server", "stop-server"] :
        "arn:aws:states:eu-central-1:123456789012:execution:spawnpoint-${name}:*"
      ]),
      one([for statement in data.aws_iam_policy_document.access_api.statement : statement.actions if statement.sid == "DescribeNestedHostExecutions"]) == toset(["states:DescribeExecution"]),
      one([for statement in data.aws_iam_policy_document.access_api.statement : statement.resources if statement.sid == "DescribeNestedHostExecutions"]) == toset([
        "arn:aws:states:eu-central-1:123456789012:execution:spawnpoint-start-server:*",
        "arn:aws:states:eu-central-1:123456789012:execution:spawnpoint-stop-server:*",
      ]),
    ])
    error_message = "Operation progress reads the execution history of the operation machines and the two host machines, and describes the host machines' executions: read-only, on those executions, and no wildcard machine."
  }

  assert {
    condition = alltrue([
      one([for statement in data.aws_iam_policy_document.access_api.statement : statement.actions if statement.sid == "FindHostStartCommand"]) == toset(["ssm:ListCommands"]),
      one([for statement in data.aws_iam_policy_document.access_api.statement : statement.actions if statement.sid == "ReadHostStartOutput"]) == toset(["logs:GetLogEvents"]),
      one([for statement in data.aws_iam_policy_document.access_api.statement : statement.resources if statement.sid == "ReadHostStartOutput"]) == toset(["arn:aws:logs:eu-central-1:123456789012:log-group:/spawnpoint/session-commands:log-stream:*"]),
      local.session_command_log_group == "/spawnpoint/session-commands",
    ])
    error_message = "The host's start output is read from the session command log group only, with GetLogEvents, and the command is found with ListCommands: read-only."
  }

  assert {
    condition = alltrue([
      for statement in data.aws_iam_policy_document.access_api.statement :
      (!contains(statement.actions, "logs:GetLogEvents") || statement.sid == "ReadHostStartOutput") &&
      (!contains(statement.actions, "ssm:ListCommands") || statement.sid == "FindHostStartCommand")
    ])
    error_message = "Only the host start statements may read log events or list commands."
  }

  assert {
    condition = alltrue([
      for statement in data.aws_iam_policy_document.access_api.statement :
      !contains(statement.actions, "states:GetExecutionHistory") || (statement.sid == "ReadOperationHistory" && alltrue([for arn in statement.resources : strcontains(arn, ":execution:spawnpoint-") && endswith(arn, ":*")]))
    ])
    error_message = "Only the operation progress statement may read an execution history."
  }

  assert {
    condition     = contains(local.access_routes, "POST /auth/refresh") && contains(local.access_routes, "POST /auth/logout")
    error_message = "Persistent browser login requires explicit refresh and logout endpoints."
  }

  assert {
    condition     = contains(local.access_routes, "GET /auth/providers") && contains(local.access_routes, "POST /auth/password") && contains(local.access_routes, "POST /auth/password/register")
    error_message = "Email-and-password sign-in needs a public provider list, a login endpoint and a registration endpoint (ADR-0055)."
  }

  assert {
    condition     = aws_lambda_function.access_api.environment[0].variables.PASSWORD_LOGIN_ENABLED == "true"
    error_message = "Password sign-in for existing credentials is on unless a deployment turns it off."
  }

  assert {
    condition     = aws_lambda_function.access_api.environment[0].variables.PASSWORD_REGISTRATION_ENABLED == "false"
    error_message = "Anonymous password registration must stay closed unless a deployment deliberately opens it."
  }

  assert {
    condition = alltrue([
      for route in aws_apigatewayv2_stage.default.route_settings :
      route.throttling_burst_limit == 5 && route.throttling_rate_limit == 2
      if startswith(route.route_key, "POST /auth/")
    ]) && length([
      for route in aws_apigatewayv2_stage.default.route_settings : route
      if startswith(route.route_key, "POST /auth/")
    ]) == 6
    error_message = "Public password and email-action routes must have explicit throttles independent from normal panel traffic."
  }

  assert {
    condition = alltrue([
      contains(local.access_routes, "POST /auth/email/verification"),
      contains(local.access_routes, "POST /auth/email/verification/resend"),
      contains(local.access_routes, "POST /auth/password/forgot"),
      contains(local.access_routes, "POST /auth/password/reset"),
      contains(local.access_routes, "GET /me/accounts"),
      contains(local.access_routes, "POST /me/accounts/{provider}"),
      contains(local.access_routes, "POST /me/password"),
      contains(local.access_routes, "POST /me/password/change"),
    ])
    error_message = "Verified email, recovery and provider-neutral linked-account management must deploy together."
  }

  assert {
    condition     = contains(local.access_routes, "POST /access/candidates/{platform}/{platformUserId}/approve") && contains(local.access_routes, "POST /access/candidates/{platform}/{platformUserId}/dismiss") && !contains(local.access_routes, "POST /access/candidates/{telegramId}/approve")
    error_message = "A candidate is approved or dismissed by platform and account id, not by Telegram id alone."
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
    error_message = "The browser must be allowed to send the HttpOnly session cookie to the API."
  }

  assert {
    condition     = aws_lambda_function.access_api.environment[0].variables.LEGACY_PANEL_URL == "https://legacy.example.dev"
    error_message = "Cookie-backed writes must validate the legacy panel origin as well as the primary origin."
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
      length(data.aws_iam_policy_document.api_gateway_cloudwatch.statement) == 1 &&
      tolist(data.aws_iam_policy_document.api_gateway_cloudwatch.statement)[0].resources == toset(["*"]) &&
      tolist(data.aws_iam_policy_document.api_gateway_cloudwatch.statement)[0].actions == toset([
        "logs:CreateLogGroup",
        "logs:CreateLogStream",
        "logs:DescribeLogGroups",
        "logs:DescribeLogStreams",
        "logs:FilterLogEvents",
        "logs:GetLogEvents",
        "logs:PutLogEvents",
      ])
    )
    error_message = "The CloudWatch role must carry exactly the permissions of AmazonAPIGatewayPushToCloudWatchLogs on every resource; API Gateway refuses a narrower policy when the account setting is written."
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
    condition     = contains(local.access_routes, "PUT /games/{gameId}/worlds/{worldId}/settings") && aws_lambda_function.access_api.environment[0].variables.GAME_DNS_SUFFIX == ""
    error_message = "World connection settings need a routed API, with public DNS unavailable until its suffix is configured."
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
    condition     = aws_lambda_function.access_api.environment[0].variables.SPAWNPOINT_PLACEMENT == "single"
    error_message = "Placement (ADR-0054) must default to single, the behaviour that runs today; shared is a deliberate setting."
  }

  assert {
    condition     = aws_lambda_function.access_api.environment[0].variables.SPAWNPOINT_LAUNCH == "disabled" && aws_lambda_function.access_api.environment[0].variables.SPAWNPOINT_APP_COMMIT == "main"
    error_message = "Launching hosts (ADR-0054, phase 12) must default to disabled; a launched host checks out the commit the API names."
  }

  assert {
    condition     = aws_ssm_parameter.app_commit.name == "/spawnpoint/host/app-commit" && aws_ssm_parameter.app_commit.value == aws_lambda_function.access_api.environment[0].variables.SPAWNPOINT_APP_COMMIT
    error_message = "A running host brings its checkout to the same commit a launched host checks out (ADR-0067)."
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
    condition     = aws_lambda_function.access_api.environment[0].variables.GOOGLE_OIDC_CLIENT_ID == "1234567890-abc123def456.apps.googleusercontent.com"
    error_message = "The OIDC verifier must receive the externally configured public Google client ID."
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

run "telegram_only_deployment_switches_password_login_off" {
  command = plan

  variables {
    bootstrap_owner_telegram_id      = "1780660807"
    panel_url                        = "https://panel.example.dev/"
    session_signing_secret_parameter = "/spawnpoint/auth/session-signing-secret"
    password_login_enabled           = false
  }

  assert {
    condition     = aws_lambda_function.access_api.environment[0].variables.PASSWORD_LOGIN_ENABLED == "false"
    error_message = "A deployment that offers Telegram only must be able to turn the password routes off without a code change."
  }
}

run "registration_can_open_without_changing_password_login" {
  command = plan

  variables {
    bootstrap_owner_telegram_id       = "1780660807"
    panel_url                         = "https://panel.example.dev/"
    session_signing_secret_parameter  = "/spawnpoint/auth/session-signing-secret"
    password_registration_enabled     = true
    email_delivery_provider           = "resend"
    email_from                        = "Spawnpoint <auth@example.dev>"
  }

  assert {
    condition     = aws_lambda_function.access_api.environment[0].variables.PASSWORD_LOGIN_ENABLED == "true" && aws_lambda_function.access_api.environment[0].variables.PASSWORD_REGISTRATION_ENABLED == "true"
    error_message = "A deliberate registration window must not change whether existing password credentials can sign in."
  }

  assert {
    condition     = aws_lambda_function.access_api.environment[0].variables.EMAIL_DELIVERY_PROVIDER == "resend" && aws_lambda_function.access_api.environment[0].variables.EMAIL_FROM == "Spawnpoint <auth@example.dev>"
    error_message = "Registration must receive its email adapter through deployment configuration, never a code constant."
  }
}

run "http_api_stage_logs_requests_without_tokens" {
  command = plan

  variables {
    bootstrap_owner_telegram_id      = "1780660807"
    panel_url                        = "https://panel.example.dev/"
    session_signing_secret_parameter = "/spawnpoint/auth/session-signing-secret"
  }

  assert {
    condition = (
      aws_cloudwatch_log_group.access_api_http_access.name == "/aws/apigateway/spawnpoint-access-api" &&
      aws_cloudwatch_log_group.access_api_http_access.retention_in_days == 14 &&
      length(aws_apigatewayv2_stage.default.access_log_settings) == 1
    )
    error_message = "The HTTP API stage must record requests that never reach the Lambda, such as throttled sign-in attempts, for a bounded time."
  }

  assert {
    condition = (
      keys(jsondecode(aws_apigatewayv2_stage.default.access_log_settings[0].format)) == ["integrationErrorMessage", "requestId", "requestTime", "routeKey", "sourceIp", "status"] &&
      !strcontains(aws_apigatewayv2_stage.default.access_log_settings[0].format, "path") &&
      !strcontains(aws_apigatewayv2_stage.default.access_log_settings[0].format, "query")
    )
    error_message = "The HTTP API access log must never record the request path or query string, which can carry tokens."
  }
}

run "world_lifecycle_alarms_on_failed_and_timed_out_executions" {
  command = plan

  variables {
    bootstrap_owner_telegram_id      = "123456789"
    panel_url                        = "https://panel.example.dev/"
    session_signing_secret_parameter = "/spawnpoint/auth/session-signing-secret"
  }

  assert {
    condition = toset([for alarm in aws_cloudwatch_metric_alarm.world_lifecycle : alarm.alarm_name]) == toset([
      "spawnpoint-world-lifecycle-failed",
      "spawnpoint-world-lifecycle-timed-out",
    ])
    error_message = "The world lifecycle machine needs a failed and a timed-out alarm."
  }

  assert {
    condition = alltrue([
      for metric, alarm in aws_cloudwatch_metric_alarm.world_lifecycle :
      alarm.namespace == "AWS/States" && alarm.metric_name == metric &&
      alarm.dimensions.StateMachineArn == "arn:aws:states:eu-central-1:123456789012:stateMachine:spawnpoint-world-lifecycle" &&
      alarm.threshold == 0 && alarm.comparison_operator == "GreaterThanThreshold" &&
      alarm.treat_missing_data == "notBreaching" &&
      alarm.alarm_actions == toset(["arn:aws:sns:eu-central-1:123456789012:spawnpoint-alert"])
    ])
    error_message = "One failed or timed-out world lifecycle execution alarms the guardrails topic."
  }
}

run "api_may_invoke_only_the_release_retirement_function" {
  command = plan

  variables {
    bootstrap_owner_telegram_id      = "123456789"
    panel_url                        = "https://panel.example.dev/"
    session_signing_secret_parameter = "/spawnpoint/auth/session-signing-secret"
  }

  assert {
    condition = alltrue([
      contains(local.access_routes, "POST /games/{gameId}/presets/{presetId}/releases/{version}/retire"),
      aws_lambda_function.access_api.environment[0].variables["RELEASE_RETIREMENT_FUNCTION_NAME"] == "spawnpoint-release-retirement",
      one([for statement in data.aws_iam_policy_document.access_api.statement : statement.actions if statement.sid == "RequestReleaseRetirement"]) == toset(["lambda:InvokeFunction"]),
      one([for statement in data.aws_iam_policy_document.access_api.statement : statement.resources if statement.sid == "RequestReleaseRetirement"]) == toset(["arn:aws:lambda:eu-central-1:123456789012:function:spawnpoint-release-retirement"]),
    ])
    error_message = "The API routes the retire request and may invoke exactly the retirement function: no wildcard, no other function."
  }

  # Only that statement and the assistant's (ADR-0094) may invoke a Lambda.
  assert {
    condition = alltrue([
      for statement in data.aws_iam_policy_document.access_api.statement :
      contains(["RequestReleaseRetirement", "StartAssistantAnswers"], statement.sid)
      if length([for action in statement.actions : action if startswith(action, "lambda:")]) > 0
    ])
    error_message = "The access API role has no Lambda action outside the retirement request and the assistant's worker."
  }
}

run "an_installation_without_telegram_names_no_bootstrap_owner" {
  command = plan

  variables {
    panel_url                        = "https://panel.example.dev/"
    session_signing_secret_parameter = "/spawnpoint/auth/session-signing-secret"
  }

  assert {
    condition     = aws_lambda_function.access_api.environment[0].variables.BOOTSTRAP_OWNER_TELEGRAM_ID == ""
    error_message = "With no Telegram owner id, no Telegram account may claim the first Owner."
  }
}

run "ses_sends_from_a_dkim_signed_identity_with_no_key" {
  command = plan

  variables {
    bootstrap_owner_telegram_id      = "1780660807"
    panel_url                        = "https://spawnpoint.example.dev/"
    session_signing_secret_parameter = "/spawnpoint/auth/session-signing-secret"
    api_domain_name                  = "api.spawnpoint.example.dev"
    dns_zone_name                    = "spawnpoint.example.dev"
    email_delivery_provider          = "ses"
    email_from                       = "Spawnpoint <auth@spawnpoint.example.dev>"
  }

  assert {
    condition     = aws_sesv2_email_identity.sender[0].email_identity == "spawnpoint.example.dev"
    error_message = "The SES identity must be the sender's domain."
  }

  assert {
    condition = (
      length(aws_route53_record.ses_dkim) == 3 &&
      aws_route53_record.ses_dkim[0].name == "tokena._domainkey.spawnpoint.example.dev" &&
      aws_route53_record.ses_dkim[0].records == toset(["tokena.dkim.amazonses.com"])
    )
    error_message = "A sender inside the managed zone must be signed by DKIM records Terraform writes."
  }

  assert {
    condition     = aws_lambda_function.access_api.environment[0].variables.EMAIL_DELIVERY_PROVIDER == "ses" && length(output.ses_dkim_records) == 0
    error_message = "SES must reach the Lambda as its adapter and need no records by hand."
  }

  assert {
    condition     = local.ses_identity_arn == "arn:aws:ses:eu-central-1:123456789012:identity/spawnpoint.example.dev"
    error_message = "The Lambda may send only from the sender's own identity."
  }
}

run "an_ses_sender_outside_the_zone_gets_no_records" {
  command = plan

  variables {
    bootstrap_owner_telegram_id      = "1780660807"
    panel_url                        = "https://spawnpoint.example.dev/"
    session_signing_secret_parameter = "/spawnpoint/auth/session-signing-secret"
    api_domain_name                  = "api.spawnpoint.example.dev"
    dns_zone_name                    = "spawnpoint.example.dev"
    email_delivery_provider          = "ses"
    email_from                       = "Spawnpoint <auth@example.dev>"
  }

  assert {
    condition     = aws_sesv2_email_identity.sender[0].email_identity == "example.dev" && length(aws_route53_record.ses_dkim) == 0
    error_message = "A sender outside the managed zone must not write records into a zone that does not hold its domain."
  }

  assert {
    condition     = length(output.ses_dkim_records) == 3
    error_message = "The owner must get the DKIM records to add by hand."
  }
}

run "the_log_assistant_is_off_by_default_and_reaches_only_its_eu_models" {
  command = plan

  variables {
    bootstrap_owner_telegram_id      = "123456789"
    panel_url                        = "https://panel.example.dev/"
    session_signing_secret_parameter = "/spawnpoint/auth/session-signing-secret"
  }

  assert {
    condition = alltrue([
      aws_lambda_function.access_api.environment[0].variables["ASSISTANT_ENABLED"] == "false",
      aws_lambda_function.assistant.environment[0].variables["ASSISTANT_ENABLED"] == "false",
      aws_lambda_function.access_api.environment[0].variables["ASSISTANT_MONTHLY_CAP_USD"] == "5",
      aws_lambda_function_event_invoke_config.assistant.maximum_retry_attempts == 0,
    ])
    error_message = "The assistant must be off unless switched on, capped at five dollars a month, and never retried."
  }

  assert {
    condition = alltrue([
      for statement in data.aws_iam_policy_document.assistant.statement :
      alltrue([for action in statement.actions : contains(["dynamodb:UpdateItem", "bedrock:InvokeModel"], action)])
    ])
    error_message = "The assistant's worker may only settle answers and call Bedrock."
  }

  assert {
    condition = alltrue(flatten([
      for statement in data.aws_iam_policy_document.assistant.statement : [
        for resource in statement.resources : can(regex("^arn:aws:bedrock:eu-[a-z0-9-*]+:[0-9]*:(inference-profile/eu\\.|foundation-model/)anthropic\\.", resource))
      ] if contains(statement.actions, "bedrock:InvokeModel")
    ]))
    error_message = "The assistant may call only EU Anthropic profiles and the models behind them."
  }

  assert {
    condition = alltrue([
      contains(local.access_routes, "POST /games/{gameId}/worlds/{worldId}/log"),
      contains(local.access_routes, "GET /games/{gameId}/worlds/{worldId}/log/{readId}"),
      contains(local.access_routes, "POST /games/{gameId}/worlds/{worldId}/assistant"),
      contains(local.access_routes, "GET /games/{gameId}/worlds/{worldId}/assistant/{answerId}"),
    ])
    error_message = "The log and the assistant are routed."
  }
}
