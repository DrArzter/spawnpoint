# The persistent host (ADR-0100). Terraform created it and its data volume and
# then let them go without destroying them: the panel deletes a persistent host
# once no world is placed on it, and a resource Terraform still owned would be
# made again by the next deploy. The host, its root volume, its data volume
# (Name=spawnpoint-data) and its running-hours alarm stay in AWS until then.
# The grants below find the host by its Name tag, never by its id.

removed {
  from = aws_instance.game_host

  lifecycle {
    destroy = false
  }
}

removed {
  from = aws_ebs_volume.data

  lifecycle {
    destroy = false
  }
}

removed {
  from = aws_volume_attachment.data

  lifecycle {
    destroy = false
  }
}

removed {
  from = aws_cloudwatch_metric_alarm.running_hours

  lifecycle {
    destroy = false
  }
}

locals {
  # The Name tag the persistent host carries; the grants admit it by this tag.
  persistent_host_name = "spawnpoint-game-host"
}
