output "release_builder_project_name" {
  description = "CodeBuild project invoked only by the release-build state machine."
  value       = aws_codebuild_project.release_builder.name
}

output "build_release_state_machine_arn" {
  description = "Standard workflow invoked by GitHub Actions through its narrow OIDC role."
  value       = aws_sfn_state_machine.build_release.arn
}

output "publish_preset_catalog_state_machine_arn" {
  description = "Standard workflow invoked on config-repository pushes to refresh preset discovery."
  value       = aws_sfn_state_machine.publish_preset_catalog.arn
}
