mock_provider "aws" {
  override_during = plan

  override_data {
    target = data.aws_caller_identity.current
    values = {
      account_id = "123456789012"
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
    target = data.aws_instance.game_host
    values = {
      id = "i-00000000000000000"
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
    target = data.aws_iam_policy_document.lambda_assume_role
    values = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}"
    }
  }

  override_data {
    target = data.aws_iam_policy_document.bot
    values = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}"
    }
  }
}

run "bot_is_an_isolated_webhook" {
  command = plan

  assert {
    condition     = aws_lambda_function.bot.runtime == "nodejs22.x"
    error_message = "Pin the bot to the reviewed Node runtime."
  }

  assert {
    condition     = aws_lambda_function_url.bot.authorization_type == "NONE"
    error_message = "Telegram cannot sign SigV4; the handler verifies its webhook secret."
  }

  assert {
    condition     = aws_lambda_permission.bot_function_url.action == "lambda:InvokeFunctionUrl" && aws_lambda_permission.bot_invoke_via_url.invoked_via_function_url
    error_message = "A post-October-2025 public URL needs both permissions, with direct invocation excluded."
  }

  assert {
    condition = alltrue([
      for key in [
        "START_STATE_MACHINE_ARN",
        "WATCHDOG_STATE_MACHINE_ARN",
        "STOP_STATE_MACHINE_ARN",
        "INSTANCE_ID",
        "RELEASE_BUCKET",
        "PANEL_ADDRESS",
        "ZEROTIER_NETWORK_ID",
        "MINI_APP_URL",
        "BOT_TOKEN_PARAMETER",
        "WEBHOOK_SECRET_PARAMETER",
        "ACCESS_TABLE_NAME",
      ] : contains(keys(aws_lambda_function.bot.environment[0].variables), key)
    ])
    error_message = "Every environment value read by the handler must be wired."
  }


  assert {
    condition     = aws_lambda_function.bot.environment[0].variables["ACCESS_TABLE_NAME"] == "spawnpoint-access"
    error_message = "The bot must observe visitors in the shared access table, not another allow-list."
  }

  assert {
    condition     = aws_lambda_function.bot.environment[0].variables["BOT_TOKEN_PARAMETER"] == "/spawnpoint/bot/token"
    error_message = "Secrets stay in Parameter Store and are referenced only by name."
  }

  assert {
    condition     = length(aws_lambda_function.notifier) == 0 && length(aws_cloudwatch_event_rule.execution_notifications) == 0
    error_message = "The first slice must keep notifications disabled and deploy only the command bot."
  }
}
