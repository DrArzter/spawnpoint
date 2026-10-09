# A world's whitelist (ADR-0066), reloaded in its running game. Like the
# console's, this document runs one entry script and nothing else, on
# Spawnpoint's own hosts. Its parameters name only the world and the slot: the
# names are read on the host from the world's record, so nothing a person
# typed reaches a host's shell.

resource "aws_ssm_document" "whitelist" {
  name            = "spawnpoint-whitelist"
  document_type   = "Command"
  document_format = "JSON"

  content = jsonencode({
    schemaVersion = "2.2"
    description   = "Write a Spawnpoint world's whitelist from its record and reload it in the running game (ADR-0066)."
    parameters = {
      worldId = {
        type           = "String"
        description    = "The world whose whitelist changed."
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
      name   = "whitelist"
      inputs = {
        timeoutSeconds = "60"
        runCommand = [
          "script=/srv/spawnpoint/app/server/scripts/apply-whitelist.sh",
          "[ -x \"$script\" ] || { echo 'This host has no whitelist script yet. Update its checkout.'; exit 9; }",
          "WORLD_ID='{{ worldId }}' SPAWNPOINT_SLOT='{{ slot }}' \"$script\"",
        ]
      }
    }]
  })

  tags = {
    Name    = "spawnpoint-whitelist"
    Purpose = "whitelist"
  }
}
