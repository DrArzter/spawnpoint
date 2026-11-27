locals {
  backup_bucket_name  = "spawnpoint-backups-${data.aws_caller_identity.current.account_id}"
  release_bucket_name = "spawnpoint-releases-${data.aws_caller_identity.current.account_id}"
}

resource "aws_dynamodb_table" "control_plane_view" {
  name         = var.control_plane_view_table_name
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"
  range_key    = "sk"

  deletion_protection_enabled = true

  # A projection write tells open panels to reload (ADR-0104). The filter needs
  # only the key, so the stream carries no item: no identity of a subscription
  # ticket or connection reaches it.
  stream_enabled   = true
  stream_view_type = "KEYS_ONLY"

  attribute {
    name = "pk"
    type = "S"
  }

  attribute {
    name = "sk"
    type = "S"
  }

  point_in_time_recovery {
    enabled = true
  }

  ttl {
    attribute_name = "expires_at"
    enabled        = true
  }

  # Encrypted at rest with the AWS owned key (ADR-0101): the AWS managed key cost a KMS request per caller every
  # five minutes.
  server_side_encryption {
    enabled = false
  }

  lifecycle {
    prevent_destroy = true
  }

  tags = {
    Name    = var.control_plane_view_table_name
    Purpose = "bounded-event-history-and-read-projection"
  }
}

# The owner's reference table for content-addressed releases (ADR-0080): the
# back-references of each object, the holders of each release, and the state of
# both. It is a record that the reconciler checks against the sources of truth,
# so point-in-time recovery and deletion protection are on.
resource "aws_dynamodb_table" "release_refs" {
  name         = var.release_refs_table_name
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"
  range_key    = "sk"

  deletion_protection_enabled = true

  attribute {
    name = "pk"
    type = "S"
  }

  attribute {
    name = "sk"
    type = "S"
  }

  point_in_time_recovery {
    enabled = true
  }

  # Encrypted at rest with the AWS owned key (ADR-0101): the AWS managed key cost a KMS request per caller every
  # five minutes.
  server_side_encryption {
    enabled = false
  }

  lifecycle {
    prevent_destroy = true
  }

  tags = {
    Name    = var.release_refs_table_name
    Purpose = "content-addressed-release-references"
  }
}

resource "aws_s3_bucket" "backups" {
  bucket = local.backup_bucket_name

  tags = {
    Name    = local.backup_bucket_name
    Purpose = "world-backups"
  }

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket" "releases" {
  bucket = local.release_bucket_name

  tags = {
    Name    = local.release_bucket_name
    Purpose = "immutable-mod-releases"
  }

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_ownership_controls" "backups" {
  bucket = aws_s3_bucket.backups.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_ownership_controls" "releases" {
  bucket = aws_s3_bucket.releases.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "backups" {
  bucket = aws_s3_bucket.backups.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_public_access_block" "releases" {
  bucket = aws_s3_bucket.releases.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "backups" {
  bucket = aws_s3_bucket.backups.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_versioning" "releases" {
  bucket = aws_s3_bucket.releases.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "backups" {
  bucket = aws_s3_bucket.backups.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "releases" {
  bucket = aws_s3_bucket.releases.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "backups" {
  bucket = aws_s3_bucket.backups.id

  rule {
    id     = "abort-incomplete-uploads"
    status = "Enabled"

    filter {}

    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }

  rule {
    id     = "expire-deleted-backup-versions"
    status = "Enabled"

    filter {}

    expiration {
      expired_object_delete_marker = true
    }

    # spawnpoint-backup-retention (../terraform-operations) deletes current
    # archives outside 5/2/2. Versioning then gives a month to recover from a
    # buggy or accidental deletion without retaining every deleted archive forever.
    noncurrent_version_expiration {
      noncurrent_days = 30
    }
  }

  depends_on = [aws_s3_bucket_versioning.backups]
}

resource "aws_s3_bucket_lifecycle_configuration" "releases" {
  bucket = aws_s3_bucket.releases.id

  rule {
    id     = "abort-incomplete-uploads"
    status = "Enabled"

    filter {}

    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }

  # Only noncurrent versions expire, never a current object, so a release that
  # is in the store stays. A release becomes noncurrent only when deleted, and
  # the bucket policy denies that (ADR-0052). What this frees is the older
  # copies a repeated upload of the same release leaves behind.
  rule {
    id     = "expire-noncurrent-release-versions"
    status = "Enabled"

    filter {
      prefix = "releases/"
    }

    noncurrent_version_expiration {
      noncurrent_days = 30
    }
  }

  # Content-addressed objects (ADR-0080). A current object never expires: only
  # the reconciler deletes one, and only when no release names it. A delete
  # leaves a noncurrent version, which this rule keeps for 30 days; with the
  # 14 days of grace in the reference table that is the owner's undo window.
  rule {
    id     = "expire-noncurrent-object-versions"
    status = "Enabled"

    filter {
      prefix = "objects/"
    }

    noncurrent_version_expiration {
      noncurrent_days = 30
    }
  }

  # A delete marker with no version under it is removed. This never expires a
  # current object.
  rule {
    id     = "remove-object-delete-markers"
    status = "Enabled"

    filter {
      prefix = "objects/"
    }

    expiration {
      expired_object_delete_marker = true
    }
  }

  # The release builder's cache of verified upstream files (incremental builds,
  # stage 3). No release names these objects: CurseForge or a pinned mirror can
  # supply them again, so they expire by age, bytes and index together. A
  # rebuild writes them again; the older copy it leaves expires a day later.
  rule {
    id     = "expire-upstream-cache"
    status = "Enabled"

    filter {
      prefix = "upstream/"
    }

    expiration {
      days = 60
    }

    noncurrent_version_expiration {
      noncurrent_days = 1
    }
  }

  # An expired cache object leaves a delete marker; remove it once nothing
  # remains under it.
  rule {
    id     = "remove-upstream-cache-delete-markers"
    status = "Enabled"

    filter {
      prefix = "upstream/"
    }

    expiration {
      expired_object_delete_marker = true
    }
  }

  depends_on = [aws_s3_bucket_versioning.releases]
}

data "aws_iam_policy_document" "backups_bucket" {
  statement {
    sid     = "DenyInsecureTransport"
    effect  = "Deny"
    actions = ["s3:*"]

    resources = [
      aws_s3_bucket.backups.arn,
      "${aws_s3_bucket.backups.arn}/*",
    ]

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

data "aws_iam_policy_document" "releases_bucket" {
  # A world's archives open only with the release their generation names
  # (ADR-0052), and nothing computes that named set yet. Until a cleanup that
  # does exists, no principal may delete a release object.
  statement {
    sid     = "DenyReleaseDeletion"
    effect  = "Deny"
    actions = ["s3:DeleteObject", "s3:DeleteObjectVersion"]

    resources = ["arn:aws:s3:::${aws_s3_bucket.releases.bucket}/releases/*"]

    principals {
      type        = "*"
      identifiers = ["*"]
    }
  }

  # Content-addressed objects (ADR-0080). Only the reconciler may delete an
  # object, and it deletes only what the reference table and a complete mark
  # both release. No principal may delete a version: the 30-day lifecycle of
  # noncurrent versions is the undo window. DenyReleaseDeletion above is
  # unchanged, so legacy releases and manifests stay undeletable.
  statement {
    sid       = "DenyObjectDeletionExceptReconciler"
    effect    = "Deny"
    actions   = ["s3:DeleteObject"]
    resources = ["arn:aws:s3:::${aws_s3_bucket.releases.bucket}/objects/*"]

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    condition {
      test     = "ArnNotEquals"
      variable = "aws:PrincipalArn"
      values   = ["arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/${var.release_reconciler_role_name}"]
    }
  }

  statement {
    sid       = "DenyObjectVersionDeletion"
    effect    = "Deny"
    actions   = ["s3:DeleteObjectVersion"]
    resources = ["arn:aws:s3:::${aws_s3_bucket.releases.bucket}/objects/*"]

    principals {
      type        = "*"
      identifiers = ["*"]
    }
  }

  statement {
    sid     = "DenyInsecureTransport"
    effect  = "Deny"
    actions = ["s3:*"]

    resources = [
      aws_s3_bucket.releases.arn,
      "${aws_s3_bucket.releases.arn}/*",
    ]

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "backups" {
  bucket = aws_s3_bucket.backups.id
  policy = data.aws_iam_policy_document.backups_bucket.json

  depends_on = [aws_s3_bucket_public_access_block.backups]
}

resource "aws_s3_bucket_policy" "releases" {
  bucket = aws_s3_bucket.releases.id
  policy = data.aws_iam_policy_document.releases_bucket.json

  depends_on = [aws_s3_bucket_public_access_block.releases]
}
