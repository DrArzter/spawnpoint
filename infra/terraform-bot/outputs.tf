output "bot_webhook_url" {
  description = "Register this URL with Telegram together with the secret token from Parameter Store."
  value       = aws_lambda_function_url.bot.function_url
}

output "bot_function_name" {
  description = "Lambda name used by smoke checks and log inspection."
  value       = aws_lambda_function.bot.function_name
}
