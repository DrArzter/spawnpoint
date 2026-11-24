# A world's recent log (ADR-0094). Like the console's, this document runs one
# entry script and nothing else, on Spawnpoint's own hosts. Its parameters name
# only the world and the slot, so nothing a person typed reaches a host's shell.

resource "aws_ssm_document" "world_log" {
  name            = "spawnpoint-world-log"
  document_type   = "Command"
  document_format = "JSON"

  content = jsonencode({
    schemaVersion = "2.2"
    description   = "Print the recent log of a Spawnpoint world's game (ADR-0094)."
    parameters = {
      worldId = {
        type           = "String"
        description    = "The world whose log is read."
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
      name   = "worldLog"
      inputs = {
        timeoutSeconds = "30"
        runCommand = [
          "script=/srv/spawnpoint/app/server/scripts/world-log.sh",
          "[ -x \"$script\" ] || { echo 'This host has no log script yet. Update its checkout.'; exit 9; }",
          "WORLD_ID='{{ worldId }}' SPAWNPOINT_SLOT='{{ slot }}' \"$script\"",
        ]
      }
    }]
  })

  tags = {
    Name    = "spawnpoint-world-log"
    Purpose = "world-log"
  }
}
