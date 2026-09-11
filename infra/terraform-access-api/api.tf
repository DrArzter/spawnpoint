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
    ]
    resources = [
      data.aws_dynamodb_table.access.arn,
      "${data.aws_dynamodb_table.access.arn}/index/gsi1",
    ]
  }

  statement {
    sid       = "PublishInvitationEvents"
    actions   = ["events:PutEvents"]
    resources = ["arn:aws:events:${var.aws_region}:${data.aws_caller_identity.current.account_id}:event-bus/default"]
  }

  statement {
    sid       = "ReadLifecycleState"
    actions   = ["dynamodb:GetItem"]
    resources = [data.aws_dynamodb_table.lifecycle.arn]
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

  statement {
    sid     = "ReadWorldReleasePointersAndPacks"
    actions = ["s3:GetObject"]
    resources = [
      "${data.aws_s3_bucket.releases.arn}/worlds/*",
      "${data.aws_s3_bucket.releases.arn}/presets/*",
      # Presigning a pack link signs this same permission, so the panel can hand
      # a player the files without ever holding a credential.
      "${data.aws_s3_bucket.releases.arn}/releases/*",
    ]
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

  statement {
    sid     = "ControlSupportedSession"
    actions = ["states:StartExecution"]
    resources = concat(
      [for machine in local.operation_state_machines : machine.arn if contains(["start", "stop", "world"], machine.type)],
      [local.watchdog_state_machine_arn],
    )
  }

  statement {
    sid       = "VerifyTelegramLogin"
    actions   = ["ssm:GetParameter"]
    resources = ["arn:aws:ssm:${var.aws_region}:${data.aws_caller_identity.current.account_id}:parameter${var.bot_token_parameter}"]
  }
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
      ACCESS_TABLE_NAME           = data.aws_dynamodb_table.access.name
      BOOTSTRAP_OWNER_TELEGRAM_ID = trimspace(var.bootstrap_owner_telegram_id)
      BOT_TOKEN_PARAMETER         = var.bot_token_parameter
      LIFECYCLE_TABLE_NAME        = data.aws_dynamodb_table.lifecycle.name
      OPERATION_STATE_MACHINES    = jsonencode(local.operation_state_machines)
      RELEASE_BUCKET              = data.aws_s3_bucket.releases.id
      BACKUP_BUCKET               = data.aws_s3_bucket.backups.id
      CONNECTION_HOST             = var.connection_host
      WATCHDOG_STATE_MACHINE_ARN  = local.watchdog_state_machine_arn
    }
  }

  depends_on = [aws_cloudwatch_log_group.access_api]
}

resource "aws_apigatewayv2_api" "access" {
  name          = "spawnpoint-access"
  protocol_type = "HTTP"

  cors_configuration {
    allow_origins = [trimsuffix(var.panel_url, "/")]
    allow_headers = ["authorization", "content-type"]
    allow_methods = ["GET", "POST", "PUT", "OPTIONS"]
    max_age       = 3600
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
    "POST /auth/telegram",
    "GET /session",
    "GET /me",
    "GET /control-plane",
    "GET /access/roles",
    "GET /me/subscriptions",
    "PUT /me/subscriptions",
    "GET /invitations/recipients",
    "POST /games/{gameId}/worlds/{worldId}/start",
    "POST /games/{gameId}/worlds/{worldId}/stop",
    "POST /games/{gameId}/worlds/{worldId}/invitations",
    "GET /games/{gameId}/worlds/{worldId}/invitations",
    "GET /games/{gameId}/worlds/{worldId}/pack",
    "GET /games/{gameId}/worlds/{worldId}/backups",
    "POST /games/{gameId}/presets/{presetId}/worlds",
    "POST /games/{gameId}/worlds/{worldId}/archive",
    "POST /games/{gameId}/worlds/{worldId}/regenerate",
    "POST /games/{gameId}/worlds/{worldId}/wipe",
    "POST /games/{gameId}/worlds/{worldId}/restore",
    "POST /games/{gameId}/worlds/{worldId}/purge",
    "POST /access/request",
    "GET /access/candidates",
    "GET /access/identities",
    "POST /access/candidates/{telegramId}/approve",
    "POST /access/candidates/{telegramId}/dismiss",
    "POST /access/identities/{identityId}/role",
  ])
}

resource "aws_apigatewayv2_route" "access" {
  for_each = local.access_routes

  api_id             = aws_apigatewayv2_api.access.id
  route_key          = each.value
  target             = "integrations/${aws_apigatewayv2_integration.access_api.id}"
  authorization_type = "NONE"
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.access.id
  name        = "$default"
  auto_deploy = true
}

resource "aws_lambda_permission" "access_api" {
  statement_id  = "AllowApiGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.access_api.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.access.execution_arn}/*/*"
}
