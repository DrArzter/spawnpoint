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
    target = data.aws_dynamodb_table.lifecycle
    values = {
      name = "spawnpoint-lifecycle-v2"
      arn  = "arn:aws:dynamodb:eu-central-1:123456789012:table/spawnpoint-lifecycle-v2"
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
    target = data.aws_iam_policy_document.release_state_assume
    values = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }

  override_data {
    target = data.aws_iam_policy_document.release_state
    values = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
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

  override_data {
    target = data.aws_iam_policy_document.control_plane_projector_assume
    values = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }

  override_data {
    target = data.aws_iam_policy_document.control_plane_projector
    values = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }

  override_data {
    target = data.aws_iam_policy_document.control_plane_reconcile_assume
    values = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }

  override_data {
    target = data.aws_iam_policy_document.control_plane_reconcile
    values = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }

  override_data {
    target = data.aws_iam_policy_document.control_plane_reconcile_events_assume
    values = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }

  override_data {
    target = data.aws_iam_policy_document.control_plane_reconcile_events
    values = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }
}

mock_provider "archive" {
  override_during = plan

  override_data {
    target = data.archive_file.control_plane_projector
    values = {
      output_path         = "control-plane-projector.zip"
      output_base64sha256 = "test"
    }
  }

  override_data {
    target = data.archive_file.release_state
    values = {
      output_path         = "release-state.zip"
      output_base64sha256 = "test"
    }
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

run "promotion_delegates_release_state_and_composes_existing_machines" {
  command = plan

  assert {
    condition     = aws_sfn_state_machine.promote_release.type == "STANDARD"
    error_message = "Promotion waits on child machines; only a Standard workflow makes that free."
  }

  assert {
    condition     = jsondecode(aws_sfn_state_machine.promote_release.definition).States["Prepare Release"].Resource == "arn:aws:states:::lambda:invoke"
    error_message = "Promotion must delegate release-state persistence to its storage adapter."
  }

  assert {
    condition     = jsondecode(aws_sfn_state_machine.promote_release.definition).States["Start With Target"].Resource == "arn:aws:states:::states:startExecution.sync:2"
    error_message = "Promotion must run Lifecycle V2 start synchronously, so health and watchdog registration gate the commit."
  }

  assert {
    condition = alltrue([
      jsondecode(aws_sfn_state_machine.promote_release.definition).States["Start With Target"].Parameters.StateMachineArn == local.lifecycle_v2_start_arn,
      jsondecode(aws_sfn_state_machine.promote_release.definition).States["Start With Previous"].Parameters.StateMachineArn == local.lifecycle_v2_start_arn,
      jsondecode(aws_sfn_state_machine.promote_release.definition).States["Stop Origin Session"].Parameters.StateMachineArn == local.lifecycle_v2_stop_arn,
      jsondecode(aws_sfn_state_machine.promote_release.definition).States["Stop Target After Commit"].Parameters.StateMachineArn == local.lifecycle_v2_stop_arn,
      jsondecode(aws_sfn_state_machine.promote_release.definition).States["Stop Rollback Session"].Parameters.StateMachineArn == local.lifecycle_v2_stop_arn,
    ])
    error_message = "Promotion must compose only the fixed Lifecycle V2 start and stop machines."
  }

  assert {
    condition = alltrue([
      for state in ["Prepare Release", "Restore Desired After Refusal", "Commit Active", "Write Rollback Desired"] :
      jsondecode(aws_sfn_state_machine.promote_release.definition).States[state].Parameters.FunctionName == local.release_state_function_arn
    ])
    error_message = "Every release-state transition must use the same adapter Lambda."
  }

  assert {
    condition     = !strcontains(aws_sfn_state_machine.promote_release.definition, "worlds/")
    error_message = "Promotion orchestration must not know the physical S3 world layout."
  }

  assert {
    condition     = !strcontains(aws_sfn_state_machine.promote_release.definition, "watchdogStateMachineArn")
    error_message = "Promotion must leave watchdog ownership inside Lifecycle V2 start."
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
    condition = alltrue([
      data.aws_iam_policy_document.lifecycle_v2_start.statement[4].actions == toset(["ec2:StopInstances"]),
      data.aws_iam_policy_document.lifecycle_v2_start.statement[4].resources == toset(["arn:aws:ec2:eu-central-1:123456789012:instance/i-00000000000000000"]),
      data.aws_iam_policy_document.lifecycle_v2_start.statement[5].actions == toset(["ec2:DescribeInstances"]),
    ])
    error_message = "Only the V2 start failure safeguard may stop the exact configured host and poll its state."
  }

  assert {
    condition = strcontains(templatefile("${path.module}/../../workflows/idle-watchdog-v2.asl.json.tftpl", {
      coordinator_function_arn  = local.lifecycle_v2_coordinator_arn
      stop_v2_state_machine_arn = local.lifecycle_v2_stop_arn
    }), "recordPlayerObservation")
    error_message = "V2 watchdog must persist observations through the coordinator."
  }
}

run "control_plane_projection_is_event_driven_scoped_and_recoverable" {
  command = plan

  assert {
    condition = jsondecode(aws_cloudwatch_event_rule.control_plane_host_state.event_pattern).detail["instance-id"] == [
      "i-00000000000000000"
    ]
    error_message = "Host projection events must be scoped to the configured shared instance."
  }

  assert {
    condition = toset(jsondecode(aws_cloudwatch_event_rule.control_plane_execution_state.event_pattern).detail.stateMachineArn) == toset([
      for machine in local.control_plane_operation_machines : machine.arn
    ])
    error_message = "Operation projection events must cover only the supported control-plane workflows."
  }

  assert {
    condition = alltrue([
      aws_lambda_function.control_plane_projector.environment[0].variables.CONTROL_PLANE_VIEW_TABLE == "spawnpoint-control-plane-view",
      aws_lambda_function.control_plane_projector.environment[0].variables.LIFECYCLE_TABLE_NAME == "spawnpoint-lifecycle-v2",
    ])
    error_message = "The projector must use the dedicated view and established lifecycle tables."
  }

  assert {
    condition = alltrue([
      jsondecode(aws_sfn_state_machine.control_plane_reconcile.definition).States.WaitBeyondLease.Seconds == 1860,
      jsondecode(aws_sfn_state_machine.control_plane_reconcile.definition).States.RefreshProjection.Parameters.FunctionName == local.control_plane_projector_arn,
    ])
    error_message = "A stopped host must receive exactly one delayed reconciliation after the longest lifecycle lease."
  }

  assert {
    condition = alltrue([
      data.aws_iam_policy_document.control_plane_projector.statement[0].resources == toset(["arn:aws:dynamodb:eu-central-1:123456789012:table/spawnpoint-control-plane-view"]),
      data.aws_iam_policy_document.control_plane_projector.statement[1].resources == toset(["arn:aws:dynamodb:eu-central-1:123456789012:table/spawnpoint-lifecycle-v2"]),
      data.aws_iam_policy_document.control_plane_projector.statement[4].resources == toset([local.lifecycle_v2_stop_arn]),
    ])
    error_message = "The projector may update only its view, read lifecycle, and recover through the fenced stop adapter."
  }
}
