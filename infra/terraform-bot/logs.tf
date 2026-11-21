# Both functions hold Telegram chat ids in their logs, so their groups keep
# 14 days like every other group. Lambda creates /aws/lambda/<name> without
# retention on the first invocation; the import blocks adopt those groups.
locals {
  bot_log_group_name      = "/aws/lambda/spawnpoint-telegram-bot"
  notifier_log_group_name = "/aws/lambda/spawnpoint-notifier"
}

resource "aws_cloudwatch_log_group" "bot" {
  name              = local.bot_log_group_name
  retention_in_days = 14

  tags = {
    Name = "spawnpoint-telegram-bot"
  }
}

resource "aws_cloudwatch_log_group" "notifier" {
  count             = var.enable_notifications ? 1 : 0
  name              = local.notifier_log_group_name
  retention_in_days = 14

  tags = {
    Name = "spawnpoint-notifier"
  }
}

import {
  for_each = var.adopt_lambda_log_groups ? toset([local.bot_log_group_name]) : toset([])
  to       = aws_cloudwatch_log_group.bot
  id       = each.value
}

import {
  for_each = var.adopt_lambda_log_groups && var.enable_notifications ? toset([local.notifier_log_group_name]) : toset([])
  to       = aws_cloudwatch_log_group.notifier[0]
  id       = each.value
}
