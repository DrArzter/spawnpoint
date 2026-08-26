output "idle_watchdog_state_machine_arn" {
  description = "Session-scoped watchdog that invokes the verified stop after sustained idleness."
  value       = aws_sfn_state_machine.idle_watchdog.arn
}

output "promote_state_machine_arn" {
  description = "Health-gated release promotion with pointer-flip rollback."
  value       = aws_sfn_state_machine.promote_release.arn
}
