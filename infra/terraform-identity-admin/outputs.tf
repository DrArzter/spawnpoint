output "github_identity_admin_role_arn" {
  description = "Set this as AWS_IDENTITY_ROLE_ARN in the owner-reviewed production-identity environment."
  value       = aws_iam_role.github_identity_admin.arn
}

output "trusted_identity_subject" {
  description = "The one OIDC subject the role accepts; useful when diagnosing a denied assumption."
  value       = local.identity_subject
}
