output "bucket_name" {
  description = "Private S3 origin receiving the static production build."
  value       = aws_s3_bucket.site.id
}

output "distribution_id" {
  description = "CloudFront distribution invalidated after an index update when needed."
  value       = aws_cloudfront_distribution.site.id
}

output "mini_app_url" {
  description = "Public HTTPS URL opened by Telegram."
  value       = "https://${aws_cloudfront_distribution.site.domain_name}/"
}
