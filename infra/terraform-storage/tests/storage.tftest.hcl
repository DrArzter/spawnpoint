mock_provider "aws" {
  override_during = plan

  override_data {
    target = data.aws_caller_identity.current
    values = {
      account_id = "123456789012"
    }
  }

  override_data {
    target = data.aws_iam_policy_document.backups_bucket
    values = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}"
    }
  }

  override_data {
    target = data.aws_iam_policy_document.releases_bucket
    values = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}"
    }
  }
}

run "persistent_storage_is_private_versioned_and_recoverable" {
  command = plan

  assert {
    condition     = aws_s3_bucket.backups.bucket == "spawnpoint-backups-123456789012" && aws_s3_bucket.releases.bucket == "spawnpoint-releases-123456789012"
    error_message = "Storage bucket names must be deterministic and globally unique to the AWS account."
  }

  assert {
    condition     = aws_s3_bucket_versioning.backups.versioning_configuration[0].status == "Enabled" && aws_s3_bucket_versioning.releases.versioning_configuration[0].status == "Enabled"
    error_message = "Backups and releases must retain S3 object versions."
  }

  assert {
    condition = alltrue([
      aws_s3_bucket_public_access_block.backups.block_public_acls,
      aws_s3_bucket_public_access_block.backups.block_public_policy,
      aws_s3_bucket_public_access_block.backups.ignore_public_acls,
      aws_s3_bucket_public_access_block.backups.restrict_public_buckets,
      aws_s3_bucket_public_access_block.releases.block_public_acls,
      aws_s3_bucket_public_access_block.releases.block_public_policy,
      aws_s3_bucket_public_access_block.releases.ignore_public_acls,
      aws_s3_bucket_public_access_block.releases.restrict_public_buckets,
    ])
    error_message = "Persistent buckets must block every form of public access."
  }

  assert {
    condition     = one(one(aws_s3_bucket_server_side_encryption_configuration.backups.rule).apply_server_side_encryption_by_default).sse_algorithm == "AES256"
    error_message = "Backups must use no-extra-cost S3-managed encryption at rest."
  }

  assert {
    condition = anytrue([
      for rule in aws_s3_bucket_lifecycle_configuration.backups.rule :
      one(rule.noncurrent_version_expiration).noncurrent_days == 30
      if rule.id == "expire-deleted-backup-versions"
    ])
    error_message = "Deleted backup versions need a bounded 30-day recovery window."
  }

  assert {
    condition = alltrue([
      aws_dynamodb_table.control_plane_view.billing_mode == "PAY_PER_REQUEST",
      aws_dynamodb_table.control_plane_view.deletion_protection_enabled,
      aws_dynamodb_table.control_plane_view.point_in_time_recovery[0].enabled,
      aws_dynamodb_table.control_plane_view.server_side_encryption[0].enabled,
      aws_dynamodb_table.control_plane_view.ttl[0].attribute_name == "expires_at",
      aws_dynamodb_table.control_plane_view.ttl[0].enabled,
    ])
    error_message = "The control-plane view must be durable, encrypted, on-demand and able to expire bounded event history."
  }
}
