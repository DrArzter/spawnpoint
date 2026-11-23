# Both functions hold Telegram chat ids in their logs, so their groups keep
# 14 days like every other group. Each function depends on its group, so the
# group exists before Lambda could create one without retention.
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
