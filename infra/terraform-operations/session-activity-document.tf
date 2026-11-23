# The watchdog's activity probe (ADR-0082). Like the start and stop host steps,
# it runs one fixed script, and SSM checks the world id and slot against these
# patterns before any shell on the host reads them.

resource "aws_ssm_document" "session_activity" {
  name            = "spawnpoint-session-activity"
  document_type   = "Command"
  document_format = "JSON"

  content = jsonencode({
    schemaVersion = "2.2"
    description   = "Report whether one Spawnpoint world's session has players (ADR-0082)."
    parameters = {
      worldId = {
        type           = "String"
        description    = "The world to probe."
        allowedPattern = "^[a-z0-9][a-z0-9-]{0,31}$"
      }
      slot = {
        type           = "String"
        description    = "The session's slot on the host; empty for a session that was not placed."
        default        = ""
        allowedPattern = "^([0-9]{1,3})?$"
      }
    }
    mainSteps = [{
      action = "aws:runShellScript"
      name   = "sessionActivity"
      inputs = {
        timeoutSeconds = "300"
        runCommand = [
          "set -euo pipefail",
          "if [ -n '{{ slot }}' ]; then export SPAWNPOINT_SLOT='{{ slot }}'; fi",
          "WORLD_ID='{{ worldId }}' PROBE_FORMAT=json /srv/spawnpoint/app/server/scripts/check-session-activity.sh",
        ]
      }
    }]
  })

  tags = {
    Name    = "spawnpoint-session-activity"
    Purpose = "session-host-step"
  }
}
