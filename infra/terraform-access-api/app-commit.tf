# The commit production deployed, for hosts that already exist (ADR-0067). A
# launched host checks out var.app_commit through its AppCommit tag once, at
# boot. The configured host and a warm fleet host read this parameter before
# each session starts and bring their checkout to it while no game runs.
resource "aws_ssm_parameter" "app_commit" {
  name        = "/spawnpoint/host/app-commit"
  description = "The commit a Spawnpoint host checks out before a session starts (ADR-0067)."
  type        = "String"
  value       = var.app_commit

  tags = {
    Name    = "spawnpoint-host-app-commit"
    Purpose = "host-checkout"
  }
}
