# The owner's log assistant (ADR-0094). The API checks the request and the
# limits, then hands a job to this worker without waiting. Only the worker may
# call Bedrock, and only the two configured EU inference profiles.

locals {
  assistant_function_name = "spawnpoint-assistant"
  # Named, not referenced: the API names the worker too, and the two would depend on each other.
  access_api_function_name = "spawnpoint-access-api"
  assistant_models         = [var.assistant_haiku_model_id, var.assistant_sonnet_model_id]
  assistant_environment = {
    ASSISTANT_ENABLED         = var.assistant_enabled ? "true" : "false"
    ASSISTANT_MONTHLY_CAP_USD = tostring(var.assistant_monthly_cap_usd)
    ASSISTANT_HAIKU_MODEL_ID  = var.assistant_haiku_model_id
    ASSISTANT_SONNET_MODEL_ID = var.assistant_sonnet_model_id
    ASSISTANT_PRICES          = jsonencode(var.assistant_prices)
  }
}

data "archive_file" "assistant" {
  type        = "zip"
  source_dir  = "${path.module}/../../lambdas/dist/assistant-worker"
  output_path = "${path.module}/../../lambdas/dist/assistant-worker.zip"
}

resource "aws_cloudwatch_log_group" "assistant" {
  name              = "/aws/lambda/${local.assistant_function_name}"
  retention_in_days = 14
}

resource "aws_iam_role" "assistant" {
  name               = local.assistant_function_name
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json
}

resource "aws_iam_role_policy_attachment" "assistant_logs" {
  role       = aws_iam_role.assistant.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

data "aws_iam_policy_document" "assistant" {
  # The worker settles the answer it was handed, reads and writes the
  # conversation it was handed (ADR-0096), and adds what it cost to the month.
  statement {
    sid       = "KeepAnswersConversationsAndSpend"
    actions   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem"]
    resources = [data.aws_dynamodb_table.access.arn]
  }

  # A conversation's reads run in the API, as the owner, through the routes'
  # own gate (ADR-0096). The worker holds no grant to the data itself.
  statement {
    sid       = "RunReadsThroughTheApi"
    actions   = ["lambda:InvokeFunction"]
    resources = ["arn:aws:lambda:${var.aws_region}:${data.aws_caller_identity.current.account_id}:function:${local.access_api_function_name}"]
  }

  # An EU inference profile routes a call to the model in one of the EU
  # regions, so the model is granted in each of them, and only through the profile.
  statement {
    sid     = "InvokeTheAssistantsInferenceProfiles"
    actions = ["bedrock:InvokeModel"]
    resources = [
      for model in local.assistant_models : "arn:aws:bedrock:${var.aws_region}:${data.aws_caller_identity.current.account_id}:inference-profile/${model}"
    ]
  }

  statement {
    sid       = "InvokeTheModelsBehindTheProfiles"
    actions   = ["bedrock:InvokeModel"]
    resources = [for model in local.assistant_models : "arn:aws:bedrock:eu-*::foundation-model/${trimprefix(model, "eu.")}"]

    condition {
      test     = "StringLike"
      variable = "bedrock:InferenceProfileArn"
      values = [
        for model in local.assistant_models : "arn:aws:bedrock:${var.aws_region}:${data.aws_caller_identity.current.account_id}:inference-profile/${model}"
      ]
    }
  }
}

resource "aws_iam_role_policy" "assistant" {
  name   = local.assistant_function_name
  role   = aws_iam_role.assistant.id
  policy = data.aws_iam_policy_document.assistant.json
}

resource "aws_lambda_function" "assistant" {
  function_name    = local.assistant_function_name
  role             = aws_iam_role.assistant.arn
  runtime          = "nodejs22.x"
  handler          = "index.handler"
  filename         = data.archive_file.assistant.output_path
  source_code_hash = data.archive_file.assistant.output_base64sha256
  timeout          = 120
  memory_size      = 256

  environment {
    variables = {
      ACCESS_TABLE_NAME         = data.aws_dynamodb_table.access.name
      ACCESS_API_FUNCTION_NAME  = local.access_api_function_name
      ASSISTANT_ENABLED         = local.assistant_environment.ASSISTANT_ENABLED
      ASSISTANT_MONTHLY_CAP_USD = local.assistant_environment.ASSISTANT_MONTHLY_CAP_USD
      ASSISTANT_HAIKU_MODEL_ID  = local.assistant_environment.ASSISTANT_HAIKU_MODEL_ID
      ASSISTANT_SONNET_MODEL_ID = local.assistant_environment.ASSISTANT_SONNET_MODEL_ID
      ASSISTANT_PRICES          = local.assistant_environment.ASSISTANT_PRICES
    }
  }

  depends_on = [
    aws_cloudwatch_log_group.assistant,
    aws_iam_role_policy.assistant,
  ]
}

# A failed answer is settled as failed by the worker itself; a retry would ask
# the model, and spend, a second time.
resource "aws_lambda_function_event_invoke_config" "assistant" {
  function_name                = aws_lambda_function.assistant.function_name
  maximum_retry_attempts       = 0
  maximum_event_age_in_seconds = 300
}
