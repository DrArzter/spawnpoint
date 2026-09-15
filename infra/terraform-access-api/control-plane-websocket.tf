resource "aws_apigatewayv2_api" "control_plane" {
  name                       = "spawnpoint-control-plane-subscriptions"
  protocol_type              = "WEBSOCKET"
  route_selection_expression = "$request.body.action"
}

resource "aws_cloudwatch_log_group" "control_plane_subscriptions" {
  name              = "/aws/lambda/spawnpoint-control-plane-subscriptions"
  retention_in_days = 14
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
