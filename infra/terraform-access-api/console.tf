# The console gateway (ADR-0063). An operator's command reaches the game's RCON
# through one SSM document that can run nothing but the console entry script,
# and only on Spawnpoint's own hosts. The parameters' patterns are the
# injection boundary: no value that reaches the host's shell can carry a quote,
# a space or a metacharacter, and the command itself travels as base64.

data "aws_instance" "configured_host" {
  filter {
    name   = "tag:Name"
    values = ["spawnpoint-game-host"]
  }

  filter {
    name   = "instance-state-name"
    values = ["pending", "running", "stopping", "stopped"]
  }
}

resource "aws_ssm_document" "console" {
  name            = "spawnpoint-console"
  document_type   = "Command"
  document_format = "JSON"

  content = jsonencode({
    schemaVersion = "2.2"
    description   = "Run one console command against a Spawnpoint world's RCON (ADR-0063)."
    parameters = {
      worldId = {
        type           = "String"
        description    = "The world whose session receives the command."
        allowedPattern = "^[a-z0-9][a-z0-9-]{0,31}$"
      }
      slot = {
        type           = "String"
        description    = "The session's slot on the host; empty for a session that was not placed."
        default        = ""
        allowedPattern = "^([0-9]{1,3})?$"
      }
      command = {
        type           = "String"
        description    = "The command, base64-encoded."
        allowedPattern = "^[A-Za-z0-9+/]{1,1400}={0,2}$"
      }
    }
    mainSteps = [{
      action = "aws:runShellScript"
      name   = "console"
      inputs = {
        timeoutSeconds = "30"
        runCommand = [
          "script=/srv/spawnpoint/app/server/scripts/console.sh",
          "[ -x \"$script\" ] || { echo 'This host has no console script yet. Update its checkout.'; exit 9; }",
          "WORLD_ID='{{ worldId }}' SPAWNPOINT_SLOT='{{ slot }}' CONSOLE_COMMAND_B64='{{ command }}' \"$script\"",
        ]
      }
    }]
  })

  tags = {
    Name    = "spawnpoint-console"
    Purpose = "console-gateway"
  }
}

data "aws_iam_policy_document" "access_api_console" {
  # The document and the instance are both resources of a SendCommand; this
  # statement admits Spawnpoint's own documents, the console's and the
  # whitelist's (ADR-0066), and the configured host.
  statement {
    sid       = "SendOnlySpawnpointDocumentsToTheConfiguredHost"
    actions   = ["ssm:SendCommand"]
    resources = [aws_ssm_document.console.arn, aws_ssm_document.whitelist.arn, data.aws_instance.configured_host.arn]
  }

  # A launched host (ADR-0054) is admitted by its fleet tag, never by its id.
  statement {
    sid       = "SendOnlySpawnpointDocumentsToLaunchedHosts"
    actions   = ["ssm:SendCommand"]
    resources = ["arn:aws:ec2:${var.aws_region}:${data.aws_caller_identity.current.account_id}:instance/*"]

    condition {
      test     = "StringEquals"
      variable = "ssm:resourceTag/ManagedBy"
      values   = ["spawnpoint-fleet"]
    }
  }

  statement {
    sid       = "ReadConsoleCommandResults"
    actions   = ["ssm:GetCommandInvocation"]
    resources = ["*"]
  }

  # Which host and slot a session holds lives on the host records beside the
  # lifecycle records; the API already reads every item of that table.
  statement {
    sid       = "FindTheHostAndSlotOfASession"
    actions   = ["dynamodb:Scan"]
    resources = [data.aws_dynamodb_table.lifecycle.arn]
  }
}

resource "aws_iam_role_policy" "access_api_console" {
  name   = "spawnpoint-access-api-console"
  role   = aws_iam_role.access_api.id
  policy = data.aws_iam_policy_document.access_api_console.json
}
