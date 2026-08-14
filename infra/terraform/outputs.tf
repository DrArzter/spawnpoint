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
