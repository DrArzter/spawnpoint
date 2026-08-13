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

