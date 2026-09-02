output "github_release_role_arn" {
  description = "Set this as the AWS_RELEASE_ROLE_ARN GitHub repository variable."
  value       = aws_iam_role.github_release.arn
}

output "build_release_state_machine_arn" {
  description = "Set this as the AWS_BUILD_RELEASE_STATE_MACHINE_ARN GitHub repository variable."
  value       = local.build_release_state_machine_arn
}

output "publish_preset_catalog_state_machine_arn" {
  description = "Set this as the AWS_PRESET_CATALOG_STATE_MACHINE_ARN GitHub repository variable."
  value       = local.preset_catalog_state_machine_arn
}

output "trusted_github_subjects" {
  description = "Exact OIDC subjects accepted by the role; useful when diagnosing denied assumptions."
  value       = local.github_subjects
}
