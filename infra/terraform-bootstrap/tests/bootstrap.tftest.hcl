mock_provider "aws" {
  override_during = plan

  override_data {
    target = data.aws_caller_identity.current
    values = {
      account_id = "123456789012"
    }
  }

  override_data {
    target = data.aws_iam_policy_document.terraform_state
    values = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}"
    }
  }
}

run "state_bucket_is_private_versioned_and_encrypted" {
  command = plan

  assert {
    condition     = aws_s3_bucket.terraform_state.bucket == "spawnpoint-tfstate-123456789012"
    error_message = "The state bucket name must be deterministic and unique to the account."
  }

  assert {
    condition     = aws_s3_bucket_versioning.terraform_state.versioning_configuration[0].status == "Enabled"
    error_message = "Terraform state history depends on S3 versioning."
  }

  assert {
    condition = (
      aws_s3_bucket_public_access_block.terraform_state.block_public_acls &&
      aws_s3_bucket_public_access_block.terraform_state.block_public_policy &&
      aws_s3_bucket_public_access_block.terraform_state.ignore_public_acls &&
      aws_s3_bucket_public_access_block.terraform_state.restrict_public_buckets
    )
    error_message = "Terraform state must never be public."
  }

  assert {
    condition     = one(one(aws_s3_bucket_server_side_encryption_configuration.terraform_state.rule).apply_server_side_encryption_by_default).sse_algorithm == "AES256"
    error_message = "Terraform state must be encrypted without a separately billed KMS key."
  }

  assert {
    condition = alltrue([
      for rule in aws_s3_bucket_lifecycle_configuration.terraform_state_locks.rule :
      one(rule.noncurrent_version_expiration).noncurrent_days == 1
    ]) && toset([
      for rule in aws_s3_bucket_lifecycle_configuration.terraform_state_locks.rule :
      one(rule.filter).prefix
    ]) == toset([
      "spawnpoint/production.tfstate.tflock",
      "spawnpoint/storage.tfstate.tflock",
    ])
    error_message = "Versioning must not retain obsolete native lock objects indefinitely."
  }
}
