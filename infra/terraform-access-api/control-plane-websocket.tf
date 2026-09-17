resource "aws_apigatewayv2_api" "control_plane" {
  name                       = "spawnpoint-control-plane-subscriptions"
  protocol_type              = "WEBSOCKET"
  route_selection_expression = "$request.body.action"
}

resource "aws_cloudwatch_log_group" "control_plane_subscriptions" {
  name              = "/aws/lambda/spawnpoint-control-plane-subscriptions"
  retention_in_days = 14
}

resource "aws_cloudwatch_log_group" "control_plane_websocket_access" {
  name              = "/aws/apigateway/spawnpoint-control-plane-subscriptions"
  retention_in_days = 14
}

data "aws_iam_policy_document" "api_gateway_cloudwatch_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["apigateway.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "api_gateway_cloudwatch" {
  name               = "spawnpoint-apigateway-cloudwatch"
  assume_role_policy = data.aws_iam_policy_document.api_gateway_cloudwatch_assume.json
}

# The permissions of AmazonAPIGatewayPushToCloudWatchLogs, inline. API Gateway
# validates the role against that policy's shape when the account setting is
# written: a policy scoped to one log group was refused at UpdateAccount with
# "The role ARN does not have required permissions configured" (the deploy of
# 2026-09-17), so the wildcard is what the service demands, not a shortcut. The
# deploy identity may attach only the Lambda logging policy to a role, which is
# why this is inline rather than the managed policy itself.
data "aws_iam_policy_document" "api_gateway_cloudwatch" {
  statement {
    sid = "PushApiGatewayLogsToCloudWatch"
    actions = [
      "logs:CreateLogGroup",
      "logs:CreateLogStream",
      "logs:DescribeLogGroups",
      "logs:DescribeLogStreams",
      "logs:FilterLogEvents",
      "logs:GetLogEvents",
      "logs:PutLogEvents",
    ]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "api_gateway_cloudwatch" {
  name   = "spawnpoint-apigateway-cloudwatch"
  role   = aws_iam_role.api_gateway_cloudwatch.id
  policy = data.aws_iam_policy_document.api_gateway_cloudwatch.json
}

# Access logging is rejected until this regional, account-level API Gateway
# setting names a CloudWatch role. Terraform owns it here alongside the only
# API Gateway access-log destination in Spawnpoint.
resource "aws_api_gateway_account" "current" {
  cloudwatch_role_arn = aws_iam_role.api_gateway_cloudwatch.arn

  depends_on = [aws_iam_role_policy.api_gateway_cloudwatch]
}

resource "aws_iam_role" "control_plane_subscriptions" {
  name               = "spawnpoint-control-plane-subscriptions"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json
}

resource "aws_iam_role_policy_attachment" "control_plane_subscriptions_logs" {
  role       = aws_iam_role.control_plane_subscriptions.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

data "aws_iam_policy_document" "control_plane_subscriptions" {
  statement {
    sid = "ManageSubscriptionTicketsAndConnections"
    actions = [
      "dynamodb:DeleteItem",
      "dynamodb:PutItem",
      "dynamodb:Query",
    ]
    resources = [local.control_plane_view_table_arn]
  }

  statement {
    sid       = "PublishProjectionInvalidations"
    actions   = ["execute-api:ManageConnections"]
    resources = ["${aws_apigatewayv2_api.control_plane.execution_arn}/${aws_apigatewayv2_stage.control_plane.name}/POST/@connections/*"]
  }
}

resource "aws_iam_role_policy" "control_plane_subscriptions" {
  name   = "spawnpoint-control-plane-subscriptions"
  role   = aws_iam_role.control_plane_subscriptions.id
  policy = data.aws_iam_policy_document.control_plane_subscriptions.json
}

resource "aws_lambda_function" "control_plane_subscriptions" {
  function_name    = "spawnpoint-control-plane-subscriptions"
  role             = aws_iam_role.control_plane_subscriptions.arn
  runtime          = "nodejs22.x"
  handler          = "index.handler"
  filename         = data.archive_file.control_plane_subscriptions.output_path
  source_code_hash = data.archive_file.control_plane_subscriptions.output_base64sha256
  timeout          = 10
  memory_size      = 256

  environment {
    variables = {
      CONTROL_PLANE_VIEW_TABLE             = var.control_plane_view_table_name
      CONTROL_PLANE_WEBSOCKET_CALLBACK_URL = "https://${aws_apigatewayv2_api.control_plane.id}.execute-api.${var.aws_region}.amazonaws.com/${aws_apigatewayv2_stage.control_plane.name}"
    }
  }

  depends_on = [
    aws_cloudwatch_log_group.control_plane_subscriptions,
    aws_iam_role_policy.control_plane_subscriptions,
  ]
}

resource "aws_apigatewayv2_integration" "control_plane_subscriptions" {
  api_id           = aws_apigatewayv2_api.control_plane.id
  integration_type = "AWS_PROXY"
  integration_uri  = aws_lambda_function.control_plane_subscriptions.invoke_arn
}

locals {
  control_plane_websocket_routes = toset(["$connect", "$disconnect", "$default"])
}

resource "aws_apigatewayv2_route" "control_plane_subscriptions" {
  for_each = local.control_plane_websocket_routes

  api_id    = aws_apigatewayv2_api.control_plane.id
  route_key = each.value
  target    = "integrations/${aws_apigatewayv2_integration.control_plane_subscriptions.id}"
}

resource "aws_apigatewayv2_stage" "control_plane" {
  api_id      = aws_apigatewayv2_api.control_plane.id
  name        = "live"
  auto_deploy = true

  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.control_plane_websocket_access.arn
    format = jsonencode({
      requestId               = "$context.requestId"
      connectionId            = "$context.connectionId"
      sourceIp                = "$context.identity.sourceIp"
      requestTime             = "$context.requestTime"
      routeKey                = "$context.routeKey"
      status                  = "$context.status"
      integrationErrorMessage = "$context.integrationErrorMessage"
    })
  }

  depends_on = [aws_api_gateway_account.current]
}

resource "aws_lambda_permission" "control_plane_subscriptions_websocket" {
  statement_id  = "AllowWebSocketInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.control_plane_subscriptions.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.control_plane.execution_arn}/*"
}

resource "aws_cloudwatch_event_rule" "control_plane_projection_updated" {
  name        = "spawnpoint-control-plane-projection-updated"
  description = "Fan out sanitized dashboard projection invalidations."
  event_pattern = jsonencode({
    source      = ["spawnpoint.control-plane"]
    detail-type = ["Projection Updated"]
  })
}

resource "aws_cloudwatch_event_target" "control_plane_projection_updated" {
  rule = aws_cloudwatch_event_rule.control_plane_projection_updated.name
  arn  = aws_lambda_function.control_plane_subscriptions.arn
}

resource "aws_lambda_permission" "control_plane_projection_updated" {
  statement_id  = "AllowProjectionInvalidationEventBridge"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.control_plane_subscriptions.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.control_plane_projection_updated.arn
}
