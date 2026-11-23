# Identity avatars (ADR-0084): one picture per identity, copied once from a
# sign-in provider or uploaded by the person. Personal data, so the bucket is
# private and unversioned: deleting an identity deletes its picture for good.
# The panel reads a picture only through a short-lived presigned link.

locals {
  avatar_bucket_name = "spawnpoint-avatars-${data.aws_caller_identity.current.account_id}"
}

resource "aws_s3_bucket" "avatars" {
  bucket = local.avatar_bucket_name

  tags = {
    Name    = local.avatar_bucket_name
    Purpose = "identity-avatars"
  }

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_ownership_controls" "avatars" {
  bucket = aws_s3_bucket.avatars.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "avatars" {
  bucket = aws_s3_bucket.avatars.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "avatars" {
  bucket = aws_s3_bucket.avatars.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

data "aws_iam_policy_document" "avatars_bucket" {
  statement {
    sid     = "DenyInsecureTransport"
    effect  = "Deny"
    actions = ["s3:*"]

    resources = [
      aws_s3_bucket.avatars.arn,
      "${aws_s3_bucket.avatars.arn}/*",
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

resource "aws_s3_bucket_policy" "avatars" {
  bucket = aws_s3_bucket.avatars.id
  policy = data.aws_iam_policy_document.avatars_bucket.json

  depends_on = [aws_s3_bucket_public_access_block.avatars]
}

output "avatar_bucket_name" {
  description = "Private, unversioned bucket of identity avatars (ADR-0084)."
  value       = aws_s3_bucket.avatars.id
}
