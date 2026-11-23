provider "aws" {
  region  = var.aws_region
  profile = var.aws_profile

  default_tags {
    tags = {
      Project     = "spawnpoint"
      Environment = "production"
      ManagedBy   = "terraform-bootstrap"
    }
  }
}

data "aws_caller_identity" "current" {}

locals {
  state_bucket_name = "spawnpoint-tfstate-${data.aws_caller_identity.current.account_id}"
}

resource "aws_s3_bucket" "terraform_state" {
  bucket = local.state_bucket_name

  tags = {
    Name    = local.state_bucket_name
    Purpose = "terraform-state"
  }

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_ownership_controls" "terraform_state" {
  bucket = aws_s3_bucket.terraform_state.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "terraform_state" {
  bucket = aws_s3_bucket.terraform_state.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "terraform_state" {
  bucket = aws_s3_bucket.terraform_state.id

  versioning_configuration {
    status = "Enabled"
  }
}

# Every state key a root names in its backend.hcl.example. Read from those
# files, so a new root gets its lock clean-up rule without an edit here.
locals {
  state_names = sort([
    for example in fileset("${path.module}/..", "*/backend.hcl.example") :
    regex("key\\s*=\\s*\"spawnpoint/([a-z0-9-]+)\\.tfstate\"", file("${path.module}/../${example}"))[0]
  ])
}

resource "aws_s3_bucket_lifecycle_configuration" "terraform_state_locks" {
  bucket = aws_s3_bucket.terraform_state.id

  # Versioning keeps every native lock object; these rules drop the obsolete ones.
  dynamic "rule" {
    for_each = local.state_names

    content {
      id     = "expire-obsolete-${rule.value}-locks"
      status = "Enabled"

      filter {
        prefix = "spawnpoint/${rule.value}.tfstate.tflock"
      }

      expiration {
        expired_object_delete_marker = true
      }

      noncurrent_version_expiration {
        noncurrent_days = 1
      }
    }
  }

  depends_on = [aws_s3_bucket_versioning.terraform_state]
}

resource "aws_s3_bucket_server_side_encryption_configuration" "terraform_state" {
  bucket = aws_s3_bucket.terraform_state.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

data "aws_iam_policy_document" "terraform_state" {
  statement {
    sid     = "DenyInsecureTransport"
    effect  = "Deny"
    actions = ["s3:*"]

    resources = [
      aws_s3_bucket.terraform_state.arn,
      "${aws_s3_bucket.terraform_state.arn}/*",
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

resource "aws_s3_bucket_policy" "terraform_state" {
  bucket = aws_s3_bucket.terraform_state.id
  policy = data.aws_iam_policy_document.terraform_state.json

  depends_on = [aws_s3_bucket_public_access_block.terraform_state]
}
