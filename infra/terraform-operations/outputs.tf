output "idle_watchdog_state_machine_arn" {
  description = "Session-scoped watchdog that invokes the verified stop after sustained idleness."
  value       = aws_sfn_state_machine.idle_watchdog.arn
}

output "promote_state_machine_arn" {
  description = "Health-gated release promotion with pointer-flip rollback."
  value       = aws_sfn_state_machine.promote_release.arn
}

output "lifecycle_v2_start_state_machine_arn" {
  description = "Additive V2 start workflow; not a production default before explicit cutover."
  value       = aws_sfn_state_machine.lifecycle_v2_start.arn
}

output "lifecycle_v2_stop_state_machine_arn" {
  description = "Additive V2 stop workflow; owns fenced session shutdown around the accepted V1 host stop."
  value       = aws_sfn_state_machine.lifecycle_v2_stop.arn
}

output "lifecycle_v2_watchdog_state_machine_arn" {
  description = "Additive V2 watchdog; persists observations only for its exact active session."
  value       = aws_sfn_state_machine.lifecycle_v2_watchdog.arn
}

output "control_plane_projector_function_arn" {
  description = "Event-driven writer for the bounded control-plane history and dashboard projection."
  value       = aws_lambda_function.control_plane_projector.arn
}
