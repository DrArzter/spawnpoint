output "backup_bucket_name" {
  description = "Private versioned bucket receiving verified world archives."
  value       = aws_s3_bucket.backups.id
}

output "release_bucket_name" {
  description = "Private versioned source of immutable mod releases."
  value       = aws_s3_bucket.releases.id
}

output "control_plane_view_table_name" {
  description = "Bounded control-plane event history and rebuildable read projection for user-facing surfaces."
  value       = aws_dynamodb_table.control_plane_view.name
}

output "control_plane_view_table_arn" {
  description = "Scoped IAM target for projection writers and readers."
  value       = aws_dynamodb_table.control_plane_view.arn
}
