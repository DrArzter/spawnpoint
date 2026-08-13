output "backup_bucket_name" {
  description = "Private versioned bucket receiving verified world archives."
  value       = aws_s3_bucket.backups.id
}

output "release_bucket_name" {
  description = "Private versioned source of immutable mod releases."
  value       = aws_s3_bucket.releases.id
}
