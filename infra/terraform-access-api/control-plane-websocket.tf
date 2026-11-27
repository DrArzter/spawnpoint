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

  dynamic "statement" {
    for_each = length(local.panel_streams) == 0 ? [] : [1]
    content {
      sid = "ReadPanelStreams"
      actions = [
        "dynamodb:DescribeStream",
        "dynamodb:GetRecords",
        "dynamodb:GetShardIterator",
      ]
      resources = [for stream in values(local.panel_streams) : stream.arn]
    }
  }

  # ListStreams names no stream, so IAM takes no narrower resource for it.
  dynamic "statement" {
    for_each = length(local.panel_streams) == 0 ? [] : [1]
    content {
      sid       = "ListPanelStreams"
      actions   = ["dynamodb:ListStreams"]
      resources = ["*"]
    }
  }

  statement {
    sid       = "KeepFailedPanelBatches"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.panel_stream_failures.arn]
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
      LIFECYCLE_TABLE_NAME                 = data.aws_dynamodb_table.lifecycle.name
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

# A failed fan-out leaves open panels on the old state until their poll reads
# again. The stream mapping retries the batch; this says when a run failed.
resource "aws_cloudwatch_metric_alarm" "control_plane_subscriptions_errors" {
  alarm_name        = "spawnpoint-control-plane-subscriptions-errors"
  alarm_description = "The control-plane subscriptions Lambda failed: open panels may not have been told to reload. Check /aws/lambda/${aws_lambda_function.control_plane_subscriptions.function_name}."

  namespace   = "AWS/Lambda"
  metric_name = "Errors"
  dimensions = {
    FunctionName = aws_lambda_function.control_plane_subscriptions.function_name
  }

  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"

  alarm_actions = [data.aws_sns_topic.alerts.arn]
  ok_actions    = [data.aws_sns_topic.alerts.arn]

  tags = {
    Name = "spawnpoint-control-plane-subscriptions-errors"
  }
}

# --- Reload messages from the tables' own change streams (ADR-0104) ----------

data "aws_dynamodb_table" "control_plane_view" {
  name = var.control_plane_view_table_name
}

locals {
  # The streams are enabled by the roots that own the tables, which apply
  # before this one. A plan made before that apply sees no stream yet and plans
  # no mapping for it; the check below says so.
  panel_stream_candidates = {
    # Session records: the filter passes the items that carry a lifecycle
    # record; the handler drops a write that changes none of its shown fields.
    lifecycle = {
      arn = data.aws_dynamodb_table.lifecycle.stream_arn
      filters = [
        jsonencode({ dynamodb = { NewImage = { lifecycle = { M = { observedState = { S = [{ exists = true }] } } } } } }),
        jsonencode({ eventName = ["REMOVE"], dynamodb = { OldImage = { lifecycle = { M = { observedState = { S = [{ exists = true }] } } } } } }),
      ]
    }
    # The dashboard projection: one item. Tickets, connections and the event
    # journal share the table and pass nothing.
    view = {
      arn = data.aws_dynamodb_table.control_plane_view.stream_arn
      filters = [
        jsonencode({ dynamodb = { Keys = { pk = { S = ["PROJECTION#CONTROL_PLANE"] }, sk = { S = ["DYNAMIC"] } } } }),
      ]
    }
  }
  panel_streams = { for name, stream in local.panel_stream_candidates : name => stream if stream.arn != null && stream.arn != "" }
}

check "panel_streams_are_enabled" {
  assert {
    condition     = length(local.panel_streams) == length(local.panel_stream_candidates)
    error_message = "A panel table has no stream yet, so no reload message comes from it. Apply infra/terraform and infra/terraform-storage first (ADR-0104)."
  }
}

# A batch that still fails after its retries lands here: its records' changes
# reached no panel, which the panel's safety-net poll then catches.
resource "aws_sqs_queue" "panel_stream_failures" {
  name                      = "spawnpoint-panel-stream-failures"
  message_retention_seconds = 14 * 24 * 60 * 60
  sqs_managed_sse_enabled   = true

  tags = {
    Name = "spawnpoint-panel-stream-failures"
  }
}

resource "aws_lambda_event_source_mapping" "panel_streams" {
  for_each = local.panel_streams

  event_source_arn  = each.value.arn
  function_name     = aws_lambda_function.control_plane_subscriptions.arn
  starting_position = "LATEST"
  batch_size        = 100
  # A reload message is wanted now or not at all: an older one only repeats
  # what the poll has read since.
  maximum_batching_window_in_seconds = 0
  maximum_record_age_in_seconds      = 600
  maximum_retry_attempts             = 3
  bisect_batch_on_function_error     = true

  filter_criteria {
    dynamic "filter" {
      for_each = each.value.filters
      content {
        pattern = filter.value
      }
    }
  }

  destination_config {
    on_failure {
      destination_arn = aws_sqs_queue.panel_stream_failures.arn
    }
  }

  depends_on = [aws_iam_role_policy.control_plane_subscriptions]
}

resource "aws_cloudwatch_metric_alarm" "panel_stream_failures" {
  alarm_name        = "spawnpoint-panel-stream-failures"
  alarm_description = "A batch of table changes reached no open panel after its retries. Read the messages in ${aws_sqs_queue.panel_stream_failures.name} and /aws/lambda/${aws_lambda_function.control_plane_subscriptions.function_name}."

  namespace   = "AWS/SQS"
  metric_name = "ApproximateNumberOfMessagesVisible"
  dimensions = {
    QueueName = aws_sqs_queue.panel_stream_failures.name
  }

  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"

  alarm_actions = [data.aws_sns_topic.alerts.arn]
  ok_actions    = [data.aws_sns_topic.alerts.arn]

  tags = {
    Name = "spawnpoint-panel-stream-failures"
  }
}

# The age of the oldest change the mapping has not handed over yet. Above a
# minute, reload messages come late or the stream has stalled.
resource "aws_cloudwatch_metric_alarm" "panel_stream_iterator_age" {
  alarm_name        = "spawnpoint-panel-stream-iterator-age"
  alarm_description = "Table changes wait more than a minute before they reach open panels. Check /aws/lambda/${aws_lambda_function.control_plane_subscriptions.function_name}."

  namespace   = "AWS/Lambda"
  metric_name = "IteratorAge"
  dimensions = {
    FunctionName = aws_lambda_function.control_plane_subscriptions.function_name
  }

  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 60000
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"

  alarm_actions = [data.aws_sns_topic.alerts.arn]
  ok_actions    = [data.aws_sns_topic.alerts.arn]

  tags = {
    Name = "spawnpoint-panel-stream-iterator-age"
  }
}
