mock_provider "aws" {
  override_during = plan

  override_data {
    target = data.aws_caller_identity.current
    values = {
      account_id = "123456789012"
    }
  }

  override_data {
    target = data.aws_cloudfront_cache_policy.caching_optimized
    values = {
      id = "managed-cache-policy"
    }
  }

  override_data {
    target = data.aws_cloudfront_response_headers_policy.security_headers
    values = {
      id = "managed-security-headers"
    }
  }

  override_data {
    target = data.aws_iam_policy_document.site
    values = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}"
    }
  }
}

run "private_origin_and_https_edge" {
  command = plan

  assert {
    condition = alltrue([
      aws_s3_bucket_public_access_block.site.block_public_acls,
      aws_s3_bucket_public_access_block.site.block_public_policy,
      aws_s3_bucket_public_access_block.site.ignore_public_acls,
      aws_s3_bucket_public_access_block.site.restrict_public_buckets,
    ])
    error_message = "The S3 origin must never become public."
  }

  assert {
    condition     = aws_cloudfront_origin_access_control.site.signing_behavior == "always"
    error_message = "CloudFront must sign every S3 origin request."
  }

  assert {
    condition     = aws_cloudfront_distribution.site.default_cache_behavior[0].viewer_protocol_policy == "redirect-to-https"
    error_message = "Telegram Mini Apps must be served over HTTPS."
  }

  assert {
    condition     = aws_cloudfront_distribution.site.price_class == "PriceClass_100"
    error_message = "The preview stays on the smallest CloudFront edge footprint."
  }
}
