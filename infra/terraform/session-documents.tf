# The host step of a session start and stop (ADR-0082). Each document runs one
# fixed script. The parameter patterns are the injection boundary: SSM refuses a
# value that could carry a quote, a space or a shell metacharacter before any
# shell on the host reads it. The step names are the CloudWatch stream names the
# operation log reader opens (lambdas/src/control-plane/aws-operation-progress.ts).

locals {
  session_world_id_pattern = "^[a-z0-9][a-z0-9-]{0,31}$"
  session_slot_pattern     = "^([0-9]{1,3})?$"
  session_volume_pattern   = "^(vol-[0-9a-f]{8,17})?$"
  session_update_checkout  = "update=/srv/spawnpoint/app/server/scripts/update-checkout.sh; if [ -x \"$update\" ]; then \"$update\" >&2 || true; fi"

  # ADR-0085: the deployment's DNS settings travel with the host step, so a
  # host whose environment Terraform does not write (the persistent host) can
  # publish a world's name too. Values are Terraform's own, never a request's.
  session_dns_environment = concat(
    ["export SPAWNPOINT_INSTANCE_ID=\"$${SPAWNPOINT_INSTANCE_ID:-$${AWS_SSM_INSTANCE_ID:-}}\""],
    var.game_dns_zone_name == "" ? [] : [
      "export SPAWNPOINT_DNS_ZONE_ID='${data.aws_route53_zone.game[0].zone_id}' SPAWNPOINT_DNS_SUFFIX='${var.game_dns_suffix}' SPAWNPOINT_DNS_LEDGER_TABLE='${aws_dynamodb_table.lifecycle_v2.name}'",
    ],
  )
}

resource "aws_ssm_document" "start_session" {
  name            = "spawnpoint-start-session"
  document_type   = "Command"
  document_format = "JSON"

  content = jsonencode({
    schemaVersion = "2.2"
    description   = "Start one Spawnpoint world's session on this host (ADR-0082)."
    parameters = {
      worldId = {
        type           = "String"
        description    = "The world to start."
        allowedPattern = local.session_world_id_pattern
      }
      slot = {
        type           = "String"
        description    = "The session's slot on the host; empty for a session that was not placed."
        default        = ""
        allowedPattern = local.session_slot_pattern
      }
      waitForFleet = {
        type          = "String"
        description   = "Whether to wait for a launched host's bootstrap marker first."
        default       = "false"
        allowedValues = ["true", "false"]
      }
      sessionVolumeId = {
        type           = "String"
        description    = "The session volume to run the world from (ADR-0102); empty for a world on the host's own disk."
        default        = ""
        allowedPattern = local.session_volume_pattern
      }
    }
    mainSteps = [{
      action = "aws:runShellScript"
      name   = "startSession"
      inputs = {
        timeoutSeconds = "3600"
        runCommand = concat([
          "set -euo pipefail",
          # A launched host may register with SSM before cloud-init finishes.
          "if [ '{{ waitForFleet }}' = true ]; then attempt=0; until test -f /etc/spawnpoint-fleet-ready && test -x /srv/spawnpoint/app/server/scripts/start-session.sh; do attempt=$((attempt + 1)); if [ \"$attempt\" -ge 60 ]; then echo 'fleet bootstrap not ready after 300 seconds' >&2; exit 70; fi; sleep 5; done; fi",
          local.session_update_checkout,
          "if [ -n '{{ slot }}' ]; then export SPAWNPOINT_SLOT='{{ slot }}'; fi",
          "if [ -n '{{ sessionVolumeId }}' ]; then export SPAWNPOINT_SESSION_VOLUME_ID='{{ sessionVolumeId }}'; fi",
          ], local.session_dns_environment, [
          "WORLD_ID='{{ worldId }}' SESSION_FORMAT=json /srv/spawnpoint/app/server/scripts/start-session.sh",
        ])
      }
    }]
  })

  tags = {
    Name    = "spawnpoint-start-session"
    Purpose = "session-host-step"
  }
}

resource "aws_ssm_document" "stop_session" {
  name            = "spawnpoint-stop-session"
  document_type   = "Command"
  document_format = "JSON"

  content = jsonencode({
    schemaVersion = "2.2"
    description   = "Stop one Spawnpoint world's session on this host (ADR-0082)."
    parameters = {
      worldId = {
        type           = "String"
        description    = "The world to stop."
        allowedPattern = local.session_world_id_pattern
      }
      slot = {
        type           = "String"
        description    = "The session's slot on the host; empty for a session that was not placed."
        default        = ""
        allowedPattern = local.session_slot_pattern
      }
      players = {
        type          = "String"
        description   = "What to do with players who are online (ADR-0081)."
        default       = "refuse"
        allowedValues = ["refuse", "disconnect"]
      }
    }
    mainSteps = [{
      action = "aws:runShellScript"
      name   = "stopSession"
      inputs = {
        timeoutSeconds = "3600"
        runCommand = concat([
          "set -euo pipefail",
          "if [ -n '{{ slot }}' ]; then export SPAWNPOINT_SLOT='{{ slot }}'; fi",
          ], local.session_dns_environment, [
          "WORLD_ID='{{ worldId }}' SPAWNPOINT_STOP_PLAYERS='{{ players }}' /srv/spawnpoint/app/server/scripts/stop-session.sh",
        ])
      }
    }]
  })

  tags = {
    Name    = "spawnpoint-stop-session"
    Purpose = "session-host-step"
  }
}

# ADR-0102: after a session's archive is verified, the stop unmounts its session
# volume so the control plane can detach and delete it.
resource "aws_ssm_document" "unmount_session_volume" {
  name            = "spawnpoint-unmount-session-volume"
  document_type   = "Command"
  document_format = "JSON"

  content = jsonencode({
    schemaVersion = "2.2"
    description   = "Unmount one world's session volume on this host (ADR-0102)."
    parameters = {
      worldId = {
        type           = "String"
        description    = "The world whose session volume to unmount."
        allowedPattern = local.session_world_id_pattern
      }
    }
    mainSteps = [{
      action = "aws:runShellScript"
      name   = "unmountSessionVolume"
      inputs = {
        timeoutSeconds = "300"
        runCommand = [
          "set -euo pipefail",
          "/srv/spawnpoint/app/server/scripts/unmount-session-volume.sh '{{ worldId }}'",
        ]
      }
    }]
  })

  tags = {
    Name    = "spawnpoint-unmount-session-volume"
    Purpose = "session-host-step"
  }
}
