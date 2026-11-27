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

  override_data {
    target = data.aws_iam_policy_document.avatars_bucket
    values = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}"
    }
  }
}

run "avatars_are_private_and_unversioned" {
  command = plan

  assert {
    condition     = aws_s3_bucket.avatars.bucket == "spawnpoint-avatars-123456789012"
    error_message = "The avatar bucket name is deterministic per account (ADR-0084)."
  }

  assert {
    condition = alltrue([
      aws_s3_bucket_public_access_block.avatars.block_public_acls,
      aws_s3_bucket_public_access_block.avatars.block_public_policy,
      aws_s3_bucket_public_access_block.avatars.ignore_public_acls,
      aws_s3_bucket_public_access_block.avatars.restrict_public_buckets,
    ])
    error_message = "Avatars are personal data: the bucket is never public; the panel reads them through presigned links."
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
      !aws_dynamodb_table.control_plane_view.server_side_encryption[0].enabled,
      aws_dynamodb_table.control_plane_view.ttl[0].attribute_name == "expires_at",
      aws_dynamodb_table.control_plane_view.ttl[0].enabled,
    ])
    error_message = "The control-plane view must be durable, encrypted, on-demand and able to expire bounded event history."
  }

  assert {
    condition     = aws_dynamodb_table.control_plane_view.stream_enabled && aws_dynamodb_table.control_plane_view.stream_view_type == "KEYS_ONLY"
    error_message = "A projection write reaches open panels through the view table's stream, which carries keys only, so no subscription identity enters it (ADR-0104)."
  }
}

run "release_versions_expire_but_no_release_can_be_deleted" {
  command = plan

  assert {
    condition = anytrue([
      for rule in aws_s3_bucket_lifecycle_configuration.releases.rule :
      rule.status == "Enabled" &&
      one(rule.filter).prefix == "releases/" &&
      one(rule.noncurrent_version_expiration).noncurrent_days == 30 &&
      length(rule.expiration) == 0
      if rule.id == "expire-noncurrent-release-versions"
    ])
    error_message = "Noncurrent versions of release objects expire after 30 days, and no current release object ever expires."
  }

  assert {
    condition = alltrue([
      for rule in aws_s3_bucket_lifecycle_configuration.releases.rule :
      length(rule.expiration) == 0 || one(rule.filter).prefix == "upstream/" || rule.id == "remove-object-delete-markers"
    ])
    error_message = "Only the upstream cache may expire a current object in the release store (a generation may name a release object, ADR-0052); elsewhere an expiration rule may only remove a delete marker."
  }

  assert {
    condition = alltrue([
      one([for statement in data.aws_iam_policy_document.releases_bucket.statement : statement.effect if statement.sid == "DenyReleaseDeletion"]) == "Deny",
      one([for statement in data.aws_iam_policy_document.releases_bucket.statement : statement.actions if statement.sid == "DenyReleaseDeletion"]) == toset(["s3:DeleteObject", "s3:DeleteObjectVersion"]),
      one([for statement in data.aws_iam_policy_document.releases_bucket.statement : statement.resources if statement.sid == "DenyReleaseDeletion"]) == toset(["arn:aws:s3:::spawnpoint-releases-123456789012/releases/*"]),
    ])
    error_message = "No principal may delete a release object, so expiring noncurrent versions can never remove the last copy of a release."
  }
}

run "upstream_cache_expires_after_60_days" {
  command = plan

  assert {
    condition = anytrue([
      for rule in aws_s3_bucket_lifecycle_configuration.releases.rule :
      rule.status == "Enabled" &&
      one(rule.filter).prefix == "upstream/" &&
      one(rule.expiration).days == 60 &&
      one(rule.noncurrent_version_expiration).noncurrent_days == 1
      if rule.id == "expire-upstream-cache"
    ])
    error_message = "The whole upstream/ cache prefix, bytes and index together, expires 60 days after a write."
  }

  assert {
    condition = anytrue([
      for rule in aws_s3_bucket_lifecycle_configuration.releases.rule :
      rule.status == "Enabled" &&
      one(rule.filter).prefix == "upstream/" &&
      one(rule.expiration).expired_object_delete_marker == true
      if rule.id == "remove-upstream-cache-delete-markers"
    ])
    error_message = "Delete markers that cache expiry leaves are removed."
  }
}

run "content_addressed_objects_are_deleted_only_by_the_reconciler" {
  command = plan

  assert {
    condition = alltrue([
      one([for statement in data.aws_iam_policy_document.releases_bucket.statement : statement.effect if statement.sid == "DenyObjectDeletionExceptReconciler"]) == "Deny",
      one([for statement in data.aws_iam_policy_document.releases_bucket.statement : statement.actions if statement.sid == "DenyObjectDeletionExceptReconciler"]) == toset(["s3:DeleteObject"]),
      one([for statement in data.aws_iam_policy_document.releases_bucket.statement : statement.resources if statement.sid == "DenyObjectDeletionExceptReconciler"]) == toset(["arn:aws:s3:::spawnpoint-releases-123456789012/objects/*"]),
      one(flatten([for statement in data.aws_iam_policy_document.releases_bucket.statement : [for condition in statement.condition : condition.values if statement.sid == "DenyObjectDeletionExceptReconciler"]])) == "arn:aws:iam::123456789012:role/spawnpoint-release-reconciler",
    ])
    error_message = "Only the reconciler role may delete an object under objects/."
  }

  assert {
    condition = alltrue([
      one([for statement in data.aws_iam_policy_document.releases_bucket.statement : statement.effect if statement.sid == "DenyObjectVersionDeletion"]) == "Deny",
      one([for statement in data.aws_iam_policy_document.releases_bucket.statement : statement.actions if statement.sid == "DenyObjectVersionDeletion"]) == toset(["s3:DeleteObjectVersion"]),
      one([for statement in data.aws_iam_policy_document.releases_bucket.statement : statement.resources if statement.sid == "DenyObjectVersionDeletion"]) == toset(["arn:aws:s3:::spawnpoint-releases-123456789012/objects/*"]),
    ])
    error_message = "No principal may delete a version under objects/."
  }

  assert {
    condition = anytrue([
      for rule in aws_s3_bucket_lifecycle_configuration.releases.rule :
      rule.status == "Enabled" &&
      one(rule.filter).prefix == "objects/" &&
      one(rule.noncurrent_version_expiration).noncurrent_days == 30 &&
      length(rule.expiration) == 0
      if rule.id == "expire-noncurrent-object-versions"
    ])
    error_message = "Noncurrent object versions expire after 30 days, and no current object expires."
  }

  assert {
    condition = anytrue([
      for rule in aws_s3_bucket_lifecycle_configuration.releases.rule :
      rule.status == "Enabled" &&
      one(rule.filter).prefix == "objects/" &&
      one(rule.expiration).expired_object_delete_marker == true
      if rule.id == "remove-object-delete-markers"
    ])
    error_message = "Delete markers under objects/ are removed once nothing is under them."
  }
}

run "release_refs_table_is_durable_and_recoverable" {
  command = plan

  assert {
    condition = alltrue([
      aws_dynamodb_table.release_refs.name == "spawnpoint-release-refs",
      aws_dynamodb_table.release_refs.billing_mode == "PAY_PER_REQUEST",
      aws_dynamodb_table.release_refs.hash_key == "pk",
      aws_dynamodb_table.release_refs.range_key == "sk",
      aws_dynamodb_table.release_refs.deletion_protection_enabled,
      aws_dynamodb_table.release_refs.point_in_time_recovery[0].enabled,
      !aws_dynamodb_table.release_refs.server_side_encryption[0].enabled,
      length(aws_dynamodb_table.release_refs.ttl) == 0,
    ])
    error_message = "The reference table must be on-demand, encrypted, deletion-protected and recoverable, and must never expire an item."
  }
}
