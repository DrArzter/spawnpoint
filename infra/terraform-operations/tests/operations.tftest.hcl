mock_provider "aws" {
  override_during = plan

  override_data {
    target = data.aws_caller_identity.current
    values = {
      account_id = "123456789012"
    }
  }

  override_data {
    target = data.aws_s3_bucket.releases
    values = {
      id  = "spawnpoint-releases-123456789012"
      arn = "arn:aws:s3:::spawnpoint-releases-123456789012"
    }
  }

  override_data {
    target = data.aws_instance.game_host
    values = {
      id  = "i-00000000000000000"
      arn = "arn:aws:ec2:eu-central-1:123456789012:instance/i-00000000000000000"
    }
  }

  override_data {
    target = data.aws_iam_policy_document.idle_watchdog_assume_role
    values = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}"
    }
  }

  override_data {
    target = data.aws_iam_policy_document.idle_watchdog
    values = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}"
    }
  }

  override_data {
    target = data.aws_iam_policy_document.promote_workflow_assume_role
    values = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}"
    }
  }

  override_data {
    target = data.aws_iam_policy_document.promote_workflow
    values = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}"
    }
  }

  override_data {
    target = data.aws_iam_policy_document.game_host_world_pointers
    values = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}"
    }
  }

  override_data {
    target = data.aws_iam_policy_document.lifecycle_v2_start_assume
    values = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }

  override_data {
    target = data.aws_iam_policy_document.lifecycle_v2_start
    values = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }

  override_data {
    target = data.aws_iam_policy_document.lifecycle_v2_stop_assume
    values = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }

  override_data {
    target = data.aws_iam_policy_document.lifecycle_v2_stop
    values = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }

  override_data {
    target = data.aws_iam_policy_document.lifecycle_v2_watchdog_assume
    values = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }

  override_data {
    target = data.aws_iam_policy_document.lifecycle_v2_watchdog
    values = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }
}

run "host_can_read_but_never_write_world_pointers" {
  command = plan

  assert {
    condition     = aws_iam_role_policy.game_host_world_pointers.role == "spawnpoint-game-host"
    error_message = "Pointer access must attach only to the established game-host role."
  }

  assert {
    condition     = data.aws_iam_policy_document.game_host_world_pointers.statement[0].actions == toset(["s3:GetObject"])
    error_message = "The host observes pointers; only control-plane operations may write them."
  }

  assert {
    condition     = data.aws_iam_policy_document.game_host_world_pointers.statement[0].resources == toset(["arn:aws:s3:::spawnpoint-releases-123456789012/worlds/*"])
    error_message = "Host pointer access must not widen to the whole release bucket."
  }
}

run "idle_watchdog_probes_host_and_runs_verified_stop" {
  command = plan

  assert {
    condition     = aws_sfn_state_machine.idle_watchdog.type == "STANDARD"
    error_message = "The watchdog waits for hours; only a Standard workflow makes those waits free."
  }

  # The command is built by ASL from the request's world, so the assertion reads
  # the template rather than a fixed string: the probe must still be the host's
  # exit-code contract, and it must name the world the session is for.
  assert {
    condition = strcontains(
      jsondecode(aws_sfn_state_machine.idle_watchdog.definition).States["Send Probe"].Parameters.Parameters["commands.$"],
      "States.Format('WORLD_ID={} /srv/spawnpoint/app/server/scripts/idle-probe.sh', $.request.worldId)"
    )
    error_message = "The watchdog must probe through the host's exit-code contract for the world it was started for."
  }

  assert {
    condition     = jsondecode(aws_sfn_state_machine.idle_watchdog.definition).States["Stop Idle Session"].Resource == "arn:aws:states:::states:startExecution.sync:2"
    error_message = "The watchdog must run the verified stop workflow synchronously, so a refusal is observable."
  }
}

run "promotion_flips_the_pointer_and_composes_existing_machines" {
  command = plan

  assert {
    condition     = aws_sfn_state_machine.promote_release.type == "STANDARD"
    error_message = "Promotion waits on child machines; only a Standard workflow makes that free."
  }

  assert {
    condition     = jsondecode(aws_sfn_state_machine.promote_release.definition).States["Write Desired"].Resource == "arn:aws:states:::aws-sdk:s3:putObject"
    error_message = "The pointer must be written by a direct S3 integration, not a Lambda wrapper."
  }

  assert {
    condition     = jsondecode(aws_sfn_state_machine.promote_release.definition).States["Start With Target"].Resource == "arn:aws:states:::states:startExecution.sync:2"
    error_message = "Promotion must run the existing start machine synchronously, so health gates the commit."
  }

  assert {
    condition = alltrue([
      for state in ["Write Desired", "Restore Desired After Refusal", "Commit Active", "Write Rollback Desired"] :
      jsondecode(aws_sfn_state_machine.promote_release.definition).States[state].Parameters["Body.$"] == "$.document"
    ])
    error_message = "S3 SDK integration must receive the pointer object directly; JsonToString would double-encode it."
  }
}

run "lifecycle_v2_workflows_are_additive_standard_and_session_scoped" {
  command = plan

  assert {
    condition = alltrue([
      aws_sfn_state_machine.lifecycle_v2_start.type == "STANDARD",
      aws_sfn_state_machine.lifecycle_v2_stop.type == "STANDARD",
      aws_sfn_state_machine.lifecycle_v2_watchdog.type == "STANDARD",
    ])
    error_message = "Every multi-minute Lifecycle V2 operation must remain a Standard Workflow."
  }

  assert {
    condition = alltrue([
      aws_sfn_state_machine.lifecycle_v2_start.name == "spawnpoint-start-server-v2",
      aws_sfn_state_machine.lifecycle_v2_stop.name == "spawnpoint-stop-server-v2",
      aws_sfn_state_machine.lifecycle_v2_watchdog.name == "spawnpoint-idle-watchdog-v2",
    ])
    error_message = "V2 resources must remain separate from production V1 names until explicit cutover."
  }

  assert {
    condition     = local.lifecycle_v2_coordinator_arn == "arn:aws:lambda:eu-central-1:123456789012:function:spawnpoint-lifecycle-coordinator-v2"
    error_message = "The operations root must invoke only the established coordinator by its stable name."
  }

  assert {
    condition = strcontains(templatefile("${path.module}/../../workflows/idle-watchdog-v2.asl.json.tftpl", {
      coordinator_function_arn  = local.lifecycle_v2_coordinator_arn
      stop_v2_state_machine_arn = local.lifecycle_v2_stop_arn
    }), "recordPlayerObservation")
    error_message = "V2 watchdog must persist observations through the coordinator."
  }
}
