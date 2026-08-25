output "game_host_instance_id" {
  description = "Stable identifier consumed later by Step Functions and SSM."
  value       = aws_instance.game_host.id
}

output "data_volume_id" {
  description = "Persistent zonal data volume; never infer it from Linux device order."
  value       = aws_ebs_volume.data.id
}

output "availability_zone_id" {
  description = "Physical AZ identity paired with the zonal data volume."
  value       = data.aws_availability_zone.selected.zone_id
}

output "security_group_id" {
  description = "Zero-ingress security group used by the game host."
  value       = aws_security_group.game_host.id
}

output "backup_bucket_name" {
  description = "Private versioned bucket receiving verified world archives."
  value       = data.aws_s3_bucket.backups.id
}

output "release_bucket_name" {
  description = "Private versioned source of immutable mod releases."
  value       = data.aws_s3_bucket.releases.id
}

output "start_state_machine_arn" {
  description = "Standard workflow used by the minimal M2 trigger and later control-plane surfaces."
  value       = aws_sfn_state_machine.start_server.arn
}

output "stop_state_machine_arn" {
  description = "Standard workflow that backs up a quiet session before stopping EC2."
  value       = aws_sfn_state_machine.stop_server.arn
}

output "lifecycle_v2_table_name" {
  description = "Inert until V2 cutover; stores only shared lifecycle coordination state, not operation history."
  value       = aws_dynamodb_table.lifecycle_v2.name
}

output "lifecycle_v2_table_arn" {
  description = "Scoped target for the later lifecycle coordinator role."
  value       = aws_dynamodb_table.lifecycle_v2.arn
}

output "lifecycle_v2_coordinator_function_name" {
  description = "Inert coordinator Lambda; no V1 workflow has invoke permission."
  value       = aws_lambda_function.lifecycle_coordinator.function_name
}

output "lifecycle_v2_coordinator_function_arn" {
  description = "Scoped target for the later V2 workflow roles."
  value       = aws_lambda_function.lifecycle_coordinator.arn
}

output "idle_watchdog_state_machine_arn" {
  description = "Session-scoped watchdog: counts empty player checks, then runs the verified stop."
  value       = aws_sfn_state_machine.idle_watchdog.arn
}

output "running_hours_alarm_name" {
  description = "Backstop behind the watchdog; alarms to the guardrails topic after too many consecutive running hours."
  value       = aws_cloudwatch_metric_alarm.running_hours.alarm_name
}

output "promote_state_machine_arn" {
  description = "Release promotion: desired, verified stop and start, health-gated active commit, pointer-flip rollback."
  value       = aws_sfn_state_machine.promote_release.arn
}

output "bot_webhook_url" {
  description = "Register with Telegram setWebhook, together with the secret token from Parameter Store."
  value       = aws_lambda_function_url.bot.function_url
}

output "release_builder_project_name" {
  description = "CodeBuild project invoked only by the release proposal state machine."
  value       = aws_codebuild_project.release_builder.name
}

output "build_release_state_machine_arn" {
  description = "Standard workflow later invoked by GitHub Actions through its narrow OIDC role."
  value       = aws_sfn_state_machine.build_release.arn
}
