output "github_release_role_arn" {
  description = "Set this as the AWS_RELEASE_ROLE_ARN GitHub repository variable."
  value       = aws_iam_role.github_release.arn
}

output "github_deploy_role_arn" {
  description = "Set this as AWS_DEPLOY_ROLE_ARN in the Spawnpoint repository production environment."
  value       = aws_iam_role.github_deploy.arn
}

output "github_plan_role_arn" {
  description = "Set this as AWS_PLAN_ROLE_ARN in the owner-reviewed production-plan environment."
  value       = aws_iam_role.github_plan.arn
}

output "build_release_state_machine_arn" {
  description = "Set this as the AWS_BUILD_RELEASE_STATE_MACHINE_ARN GitHub repository variable."
  value       = local.build_release_state_machine_arn
}

output "publish_preset_catalog_state_machine_arn" {
  description = "Set this as the AWS_PRESET_CATALOG_STATE_MACHINE_ARN GitHub repository variable."
  value       = local.preset_catalog_state_machine_arn
}

output "release_bucket_name" {
  description = "Set this as the AWS_RELEASE_BUCKET GitHub repository variable."
  value       = "spawnpoint-releases-${data.aws_caller_identity.current.account_id}"
}

output "trusted_github_subjects" {
  description = "Exact OIDC subjects accepted by the role; useful when diagnosing denied assumptions."
  value       = local.github_subjects
}
