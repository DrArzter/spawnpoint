mock_provider "aws" {
  override_during = plan

  override_data {
    target = data.aws_caller_identity.current
    values = {
      account_id = "123456789012"
    }
  }

  override_data {
    target = data.aws_route53_zone.primary
    values = {
      zone_id = "Z00000000000000000000"
      name    = "spawnpoint.example.dev."
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

  override_resource {
    target = aws_cloudfront_distribution.site
    values = {
      domain_name    = "distribution.cloudfront.net"
      hosted_zone_id = "ZCLOUDFRONT"
    }
  }
}

mock_provider "aws" {
  alias = "us_east_1"
}

run "private_origin_and_https_edge" {
  command = plan

  variables {
    domain_name = "spawnpoint.example.dev"
  }

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

  assert {
    condition     = aws_cloudfront_distribution.site.aliases == toset(["spawnpoint.example.dev"])
    error_message = "CloudFront must serve the externally configured panel hostname."
  }

  assert {
    condition = (
      aws_cloudfront_distribution.site.viewer_certificate[0].cloudfront_default_certificate == null &&
      aws_cloudfront_distribution.site.viewer_certificate[0].minimum_protocol_version == "TLSv1.2_2021" &&
      aws_cloudfront_distribution.site.viewer_certificate[0].ssl_support_method == "sni-only"
    )
    error_message = "The custom hostname must use the validated ACM certificate and modern viewer TLS."
  }

  assert {
    condition = (
      aws_route53_record.site_ipv4.name == "spawnpoint.example.dev" &&
      aws_route53_record.site_ipv6.name == "spawnpoint.example.dev" &&
      aws_route53_record.site_ipv4.alias[0].zone_id == "ZCLOUDFRONT" &&
      aws_route53_record.site_ipv6.alias[0].zone_id == "ZCLOUDFRONT"
    )
    error_message = "Both IP families must alias the panel hostname to the distribution without a hosted-zone constant."
  }
}
