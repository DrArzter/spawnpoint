output "access_table_name" {
  description = "Shared identity, linked-account and access-candidate store used by every control surface."
  value       = aws_dynamodb_table.access.name
}

output "access_table_arn" {
  description = "Scoped IAM target for Spawnpoint identity and authorization components."
  value       = aws_dynamodb_table.access.arn
}
