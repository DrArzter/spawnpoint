provider "aws" {
  region  = var.aws_region
  profile = var.aws_profile

  default_tags {
    tags = {
      Project     = "spawnpoint"
      Environment = "production"
      ManagedBy   = "terraform-web"
    }
  }
}

# CloudFront accepts ACM certificates only from us-east-1. This alias is an AWS
# edge-service invariant, not the region in which the site's S3 origin lives.
provider "aws" {
  alias   = "us_east_1"
  region  = "us-east-1"
  profile = var.aws_profile

  default_tags {
    tags = {
      Project     = "spawnpoint"
      Environment = "production"
      ManagedBy   = "terraform-web"
    }
  }
}

data "aws_caller_identity" "current" {}

data "aws_route53_zone" "primary" {
  name         = var.domain_name
  private_zone = false
}

data "aws_cloudfront_cache_policy" "caching_optimized" {
  name = "Managed-CachingOptimized"
}
