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
  value       = "https://${var.domain_name}/"
}

output "cloudfront_url" {
  description = "Provider hostname retained as a migration and diagnostic path."
  value       = "https://${aws_cloudfront_distribution.site.domain_name}/"
}

output "certificate_arn" {
  description = "Issued us-east-1 ACM certificate attached to CloudFront."
  value       = aws_acm_certificate_validation.site.certificate_arn
}
