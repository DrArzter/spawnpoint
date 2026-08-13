output "state_bucket_name" {
  description = "Copy this value into infra/terraform/backend.hcl."
  value       = aws_s3_bucket.terraform_state.id
}
