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
    target = data.aws_instances.persistent_host
    values = { ids = ["i-0123456789abcdef0"] }
  }

  override_data {
    target = data.aws_dynamodb_table.lifecycle
    values = {
      name = "spawnpoint-lifecycle-v2"
      arn  = "arn:aws:dynamodb:eu-central-1:123456789012:table/spawnpoint-lifecycle-v2"
    }
  }

  override_data {
    target = data.aws_sns_topic.fleet_alerts
    values = { arn = "arn:aws:sns:eu-central-1:123456789012:spawnpoint-alert" }
  }

  override_data {
    target = data.aws_iam_policy_document.delete_host_assume
    values = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }

  override_data {
    target = data.aws_iam_policy_document.delete_host
    values = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }

  override_data {
    target = data.aws_iam_policy_document.lifecycle_v2_drain_assume
    values = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }

  override_data {
    target = data.aws_iam_policy_document.lifecycle_v2_drain
    values = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }

  override_data {
    target = data.aws_iam_policy_document.backup_retention_assume
    values = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }

  override_data {
    target = data.aws_iam_policy_document.backup_retention
    values = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }

  override_data {
    target = data.aws_iam_policy_document.release_retirement_assume
    values = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }

  override_data {
    target = data.aws_iam_policy_document.release_retirement
    values = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }

  override_data {
    target = data.aws_iam_policy_document.release_reconciler_assume
    values = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }

  override_data {
    target = data.aws_iam_policy_document.release_reconciler
    values = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }

  override_data {
    target = data.aws_iam_policy_document.fleet_sweeper_assume
    values = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }

  override_data {
    target = data.aws_iam_policy_document.fleet_sweeper
    values = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
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
    target = data.aws_iam_policy_document.game_host_backup_holders
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
    target = data.aws_iam_policy_document.session_volume_create
    values = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }

  override_data {
    target = data.aws_iam_policy_document.session_volume_release
    values = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }

  override_data {
    target = data.aws_iam_policy_document.lifecycle_v2_start_session_volume
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
    target = data.archive_file.backup_retention
    values = {
      output_path         = "backup-retention.zip"
      output_base64sha256 = "test"
    }
  }

  override_data {
    target = data.archive_file.release_reconciler
    values = {
      output_path         = "release-reconciler.zip"
      output_base64sha256 = "test"
    }
  }

  override_data {
    target = data.archive_file.release_retirement
    values = {
      output_path         = "release-retirement.zip"
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

run "game_host_holds_a_release_for_a_new_backup_and_nothing_else_in_the_table" {
  command = plan

  assert {
    condition     = aws_iam_role_policy.game_host_backup_holders.role == "spawnpoint-game-host"
    error_message = "The backup holder permission must attach only to the established game-host role."
  }

  assert {
    condition = (
      toset(one(data.aws_iam_policy_document.game_host_backup_holders.statement).actions) == toset(["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem"]) &&
      toset(one(data.aws_iam_policy_document.game_host_backup_holders.statement).resources) == toset(["arn:aws:dynamodb:eu-central-1:123456789012:table/spawnpoint-release-refs"]) &&
      one(one(data.aws_iam_policy_document.game_host_backup_holders.statement).condition).variable == "dynamodb:LeadingKeys" &&
      toset(one(one(data.aws_iam_policy_document.game_host_backup_holders.statement).condition).values) == toset(["release#*"])
    )
    error_message = "The host may only get, put and update release items: no delete, scan, query or file items."
  }
}

run "watchdog_probe_passes_values_only_through_its_document" {
  command = plan

  override_resource {
    target          = aws_ssm_document.session_activity
    override_during = plan
    values = {
      arn = "arn:aws:ssm:eu-central-1:123456789012:document/spawnpoint-session-activity"
    }
  }

  assert {
    condition = (
      jsondecode(aws_ssm_document.session_activity.content).parameters.worldId.allowedPattern == "^[a-z0-9][a-z0-9-]{0,31}$"
      && jsondecode(aws_ssm_document.session_activity.content).parameters.slot.allowedPattern == "^([0-9]{1,3})?$"
      && strcontains(aws_ssm_document.session_activity.content, "PROBE_FORMAT=json")
    )
    error_message = "SSM must refuse a world id or slot that could carry shell syntax before the probe script reads it (ADR-0082)."
  }

  assert {
    condition = alltrue([
      for state in ["Send Placed Probe", "Send Structured Probe"] :
      jsondecode(aws_sfn_state_machine.lifecycle_v2_watchdog.definition).States[state].Parameters.DocumentName == aws_ssm_document.session_activity.name
      && !contains(keys(jsondecode(aws_sfn_state_machine.lifecycle_v2_watchdog.definition).States[state].Parameters.Parameters), "commands.$")
    ])
    error_message = "The watchdog probes through its document with named parameters, never a shell line built from the request."
  }

  assert {
    condition = (
      contains(flatten([for statement in data.aws_iam_policy_document.lifecycle_v2_watchdog.statement : tolist(statement.resources) if statement.sid == "ProbeOnlySpawnpointHost"]), aws_ssm_document.session_activity.arn)
      && !anytrue([for resource in flatten([for statement in data.aws_iam_policy_document.lifecycle_v2_watchdog.statement : tolist(statement.resources) if statement.sid == "ProbeOnlySpawnpointHost"]) : strcontains(resource, "AWS-RunShellScript")])
    )
    error_message = "The V2 watchdog may send only its probe document, not an arbitrary shell command."
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
      for state in ["Prepare Release", "Restore Desired After Refusal", "Keep Pre-Promotion Backup", "Restore Desired After Missing Backup", "Commit Active", "Write Rollback Desired"] :
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
      one([for statement in data.aws_iam_policy_document.lifecycle_v2_start.statement : statement.actions if statement.sid == "ForceStopOnlyFailedStartHost"]) == toset(["ec2:StopInstances"]),
      anytrue([for statement in data.aws_iam_policy_document.lifecycle_v2_start.statement : statement.sid == "ForceStopOnlyFailedStartHost" && anytrue([for condition in statement.condition : condition.variable == "ec2:ResourceTag/Name" && contains(condition.values, "spawnpoint-game-host")])]),
      one([for statement in data.aws_iam_policy_document.lifecycle_v2_start.statement : statement.actions if statement.sid == "ForceStopOnlyFailedLaunchedHost"]) == toset(["ec2:StopInstances"]),
      one([for statement in data.aws_iam_policy_document.lifecycle_v2_start.statement : statement.actions if statement.sid == "ObserveForcedStop"]) == toset(["ec2:DescribeInstances"]),
      one([for statement in data.aws_iam_policy_document.lifecycle_v2_start.statement : statement.actions if statement.sid == "DescribeHostShape"]) == toset(["ec2:DescribeInstanceTypes"]),
    ])
    error_message = "The V2 failure safeguard may stop the configured host or a tagged fleet host, and may only observe EC2 state and host shape otherwise."
  }

  assert {
    condition = strcontains(templatefile("${path.module}/../../workflows/idle-watchdog-v2.asl.json.tftpl", {
      coordinator_function_arn   = local.lifecycle_v2_coordinator_arn
      stop_v2_state_machine_arn  = local.lifecycle_v2_stop_arn
      watchdog_state_machine_arn = local.lifecycle_v2_watchdog_arn
    }), "recordPlayerObservation")
    error_message = "V2 watchdog must persist observations through the coordinator."
  }

  assert {
    condition = alltrue([
      contains(flatten([for statement in data.aws_iam_policy_document.lifecycle_v2_watchdog.statement : tolist(statement.actions) if statement.sid == "PublishHostMemory"]), "cloudwatch:PutMetricData"),
      contains([for condition in flatten([for statement in data.aws_iam_policy_document.lifecycle_v2_watchdog.statement : statement.condition if statement.sid == "PublishHostMemory"]) : "${condition.variable}=${join(",", condition.values)}"], "cloudwatch:namespace=Spawnpoint/Host"),
    ])
    error_message = "The watchdog may publish host memory and only into the Spawnpoint/Host namespace."
  }
}

run "control_plane_projection_is_event_driven_scoped_and_recoverable" {
  command = plan

  assert {
    condition = jsondecode(aws_cloudwatch_event_rule.control_plane_host_state.event_pattern).detail["instance-id"] == [
      "i-0123456789abcdef0"
    ]
    error_message = "Host projection events must be scoped to the persistent host."
  }

  assert {
    condition = toset(jsondecode(aws_cloudwatch_event_rule.control_plane_execution_state.event_pattern).detail.stateMachineArn) == toset([
      for machine in local.control_plane_operation_machines : machine.arn
    ])
    error_message = "Operation projection events must cover only the supported control-plane workflows."
  }

  assert {
    condition = alltrue([
      toset(jsondecode(aws_cloudwatch_event_rule.control_plane_terminal_reconcile.event_pattern).detail.stateMachineArn) == toset([for machine in local.control_plane_operation_machines : machine.arn]),
      toset(jsondecode(aws_cloudwatch_event_rule.control_plane_terminal_reconcile.event_pattern).detail.status) == toset(["FAILED", "TIMED_OUT", "ABORTED"]),
    ])
    error_message = "Every terminal supported operation must schedule the same one-shot reconciliation safety net."
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
      one([for statement in data.aws_iam_policy_document.control_plane_projector.statement : statement.resources if statement.sid == "WriteControlPlaneProjection"]) == toset(["arn:aws:dynamodb:eu-central-1:123456789012:table/spawnpoint-control-plane-view"]),
      one([for statement in data.aws_iam_policy_document.control_plane_projector.statement : statement.resources if statement.sid == "ReadLifecycleForRecovery"]) == toset(["arn:aws:dynamodb:eu-central-1:123456789012:table/spawnpoint-lifecycle-v2"]),
      one([for statement in data.aws_iam_policy_document.control_plane_projector.statement : statement.resources if statement.sid == "RecoverOnlyThroughFencedStop"]) == toset([local.lifecycle_v2_stop_arn]),
      one([for statement in data.aws_iam_policy_document.control_plane_projector.statement : statement.actions if statement.sid == "PublishProjectionInvalidations"]) == toset(["events:PutEvents"]),
      one([for statement in data.aws_iam_policy_document.control_plane_projector.statement : statement.resources if statement.sid == "PublishProjectionInvalidations"]) == toset(["arn:aws:events:eu-central-1:123456789012:event-bus/default"]),
    ])
    error_message = "The projector may update only its view, read lifecycle, recover through the fenced stop adapter and publish sanitized invalidations."
  }

  assert {
    condition = alltrue([
      toset(jsondecode(aws_cloudwatch_event_rule.game_dns_terminal_host.event_pattern).detail.state) == toset(["stopped", "terminated"]),
      one([for statement in data.aws_iam_policy_document.control_plane_projector.statement : statement.actions if statement.sid == "CleanTerminalHostDnsLedger"]) == toset(["dynamodb:DeleteItem"]),
    ])
    error_message = "Stopped and terminated Fleet hosts must trigger scoped DNS-ledger cleanup."
  }
}

run "launched_hosts_are_placed_drained_and_let_go_by_tag" {
  command = plan

  assert {
    condition = alltrue([
      aws_sfn_state_machine.lifecycle_v2_drain.type == "STANDARD",
      strcontains(aws_sfn_state_machine.lifecycle_v2_drain.definition, "decideDrain"),
      strcontains(aws_sfn_state_machine.lifecycle_v2_drain.definition, "concludeDrain"),
      strcontains(aws_sfn_state_machine.lifecycle_v2_drain.definition, "expectedRevision"),
      strcontains(aws_sfn_state_machine.lifecycle_v2_drain.definition, "arn:aws:states:::aws-sdk:ec2:terminateInstances"),
      strcontains(aws_sfn_state_machine.lifecycle_v2_drain.definition, "arn:aws:states:::aws-sdk:ec2:stopInstances"),
    ])
    error_message = "The drain machine is a durable Standard workflow that asks the coordinator and then stops or lets a host go."
  }

  assert {
    condition = alltrue([
      aws_cloudwatch_event_rule.fleet_sweep.schedule_expression == "rate(5 minutes)",
      aws_cloudwatch_event_target.fleet_sweep.rule == aws_cloudwatch_event_rule.fleet_sweep.name,
      aws_lambda_function.fleet_sweeper.environment[0].variables["DRAIN_STATE_MACHINE_ARN"] == local.lifecycle_v2_drain_arn,
      one([for statement in data.aws_iam_policy_document.fleet_sweeper.statement : statement.resources if statement.sid == "RestartFencedDrain"]) == toset([local.lifecycle_v2_drain_arn]),
      one([for statement in data.aws_iam_policy_document.fleet_sweeper.statement : statement.resources if statement.sid == "ObserveRunningDrains"]) == toset([local.lifecycle_v2_drain_arn]),
      one([for statement in data.aws_iam_policy_document.fleet_sweeper.statement : statement.actions if statement.sid == "RetryOnlyFleetHosts"]) == toset(["ec2:TerminateInstances"]),
      length(one([for statement in data.aws_iam_policy_document.fleet_sweeper.statement : statement.condition if statement.sid == "RetryOnlyFleetHosts"])) == 1,
    ])
    error_message = "The periodic Fleet backstop must invoke only the fenced drain and terminate only tagged launched hosts."
  }

  assert {
    condition = alltrue([
      strcontains(aws_sfn_state_machine.lifecycle_v2_start.definition, "arn:aws:states:::aws-sdk:ec2:createFleet"),
      strcontains(aws_sfn_state_machine.lifecycle_v2_start.definition, "\"LaunchTemplateName\": \"spawnpoint-fleet-host\""),
      strcontains(aws_sfn_state_machine.lifecycle_v2_start.definition, "\"AllowedInstanceTypes\": ${jsonencode(var.launch_families)}"),
      strcontains(aws_sfn_state_machine.lifecycle_v2_start.definition, local.lifecycle_v2_drain_arn),
      strcontains(aws_sfn_state_machine.lifecycle_v2_stop.definition, local.lifecycle_v2_drain_arn),
    ])
    error_message = "A start launches from the fleet template with the allowed families as a filter, and either a failed start or a stop that empties a launched host starts its drain."
  }

  assert {
    condition = alltrue([
      strcontains(aws_sfn_state_machine.lifecycle_v2_start.definition, "\"Commit Active Release\""),
      strcontains(aws_sfn_state_machine.lifecycle_v2_start.definition, local.release_state_function_arn),
      strcontains(aws_sfn_state_machine.lifecycle_v2_start.definition, "$.hostStart.Output.generationId"),
      jsondecode(aws_sfn_state_machine.lifecycle_v2_start.definition).States["Commit Active Release"].Catch[0].Next == "Release Start Lease",
      jsondecode(aws_sfn_state_machine.lifecycle_v2_start.definition).States["Route Release Commit"].Default == "Release Start Lease",
    ])
    error_message = "A start that reached ready must record the release it proved, and must finish the start whether or not that bookkeeping succeeds."
  }

  assert {
    condition = alltrue([
      one([for statement in data.aws_iam_policy_document.lifecycle_v2_start.statement : statement.actions if statement.sid == "LaunchFleetHosts"]) == toset(["ec2:CreateFleet", "ec2:RunInstances"]),
      one([for statement in data.aws_iam_policy_document.lifecycle_v2_start.statement : statement.actions if statement.sid == "PassOnlyTheHostRole"]) == toset(["iam:PassRole"]),
      one([for statement in data.aws_iam_policy_document.lifecycle_v2_start.statement : statement.actions if statement.sid == "TerminateOnlyLaunchedHosts"]) == toset(["ec2:TerminateInstances"]),
      one([for statement in data.aws_iam_policy_document.lifecycle_v2_start.statement : statement.resources if statement.sid == "DrainFailedLaunchedStart"]) == toset([local.lifecycle_v2_drain_arn]),
      length(one([for statement in data.aws_iam_policy_document.lifecycle_v2_start.statement : statement.condition if statement.sid == "ForceStopOnlyFailedLaunchedHost"])) == 1,
      length(one([for statement in data.aws_iam_policy_document.lifecycle_v2_start.statement : statement.condition if statement.sid == "TerminateOnlyLaunchedHosts"])) == 1,
    ])
    error_message = "The start may launch, pass only the host role, and terminate only what carries the fleet tag."
  }
}

run "v2_workflows_alarm_on_failed_and_timed_out_executions" {
  command = plan

  assert {
    condition = toset(keys(aws_cloudwatch_metric_alarm.workflow)) == toset([
      "spawnpoint-start-server-v2-failed",
      "spawnpoint-start-server-v2-timed-out",
      "spawnpoint-stop-server-v2-failed",
      "spawnpoint-stop-server-v2-timed-out",
      "spawnpoint-drain-host-v2-failed",
      "spawnpoint-drain-host-v2-timed-out",
      "spawnpoint-idle-watchdog-v2-failed",
      "spawnpoint-idle-watchdog-v2-timed-out",
    ])
    error_message = "Start, stop, drain and watchdog V2 each need a failed and a timed-out alarm."
  }

  assert {
    condition = alltrue([
      aws_cloudwatch_metric_alarm.workflow["spawnpoint-start-server-v2-failed"].dimensions.StateMachineArn == "arn:aws:states:eu-central-1:123456789012:stateMachine:spawnpoint-start-server-v2",
      aws_cloudwatch_metric_alarm.workflow["spawnpoint-stop-server-v2-timed-out"].dimensions.StateMachineArn == "arn:aws:states:eu-central-1:123456789012:stateMachine:spawnpoint-stop-server-v2",
      aws_cloudwatch_metric_alarm.workflow["spawnpoint-drain-host-v2-failed"].dimensions.StateMachineArn == "arn:aws:states:eu-central-1:123456789012:stateMachine:spawnpoint-drain-host-v2",
      aws_cloudwatch_metric_alarm.workflow["spawnpoint-idle-watchdog-v2-timed-out"].dimensions.StateMachineArn == "arn:aws:states:eu-central-1:123456789012:stateMachine:spawnpoint-idle-watchdog-v2",
    ])
    error_message = "Each alarm must watch the machine it is named for."
  }

  assert {
    condition = alltrue([
      for name, alarm in aws_cloudwatch_metric_alarm.workflow :
      (name == "spawnpoint-stop-server-v2-failed" ? alarm.namespace == "AWS/Events" && alarm.metric_name == "MatchedEvents" : alarm.namespace == "AWS/States" && contains(["ExecutionsFailed", "ExecutionsTimedOut"], alarm.metric_name)) &&
      alarm.threshold == 0 && alarm.comparison_operator == "GreaterThanThreshold" &&
      alarm.treat_missing_data == "notBreaching" &&
      alarm.alarm_actions == toset(["arn:aws:sns:eu-central-1:123456789012:spawnpoint-alert"])
    ])
    error_message = "One failed or timed-out execution alarms the guardrails topic; no execution is healthy."
  }
}

run "a_stop_refused_for_players_online_does_not_alarm" {
  command = plan

  assert {
    condition = (
      aws_cloudwatch_metric_alarm.workflow["spawnpoint-stop-server-v2-failed"].dimensions.RuleName == "spawnpoint-stop-server-v2-failed" &&
      aws_cloudwatch_metric_alarm.workflow["spawnpoint-stop-server-v2-timed-out"].dimensions.StateMachineArn == "arn:aws:states:eu-central-1:123456789012:stateMachine:spawnpoint-stop-server-v2" &&
      aws_cloudwatch_metric_alarm.workflow["spawnpoint-drain-host-v2-failed"].namespace == "AWS/States"
    )
    error_message = "Only the stop's failed alarm counts the filtered rule; its timed-out alarm and other machines count AWS/States."
  }

  assert {
    condition = (
      jsondecode(aws_cloudwatch_event_rule.workflow_failed["stop-server-v2"].event_pattern).detail.status == ["FAILED"] &&
      jsondecode(aws_cloudwatch_event_rule.workflow_failed["stop-server-v2"].event_pattern).detail.stateMachineArn == ["arn:aws:states:eu-central-1:123456789012:stateMachine:spawnpoint-stop-server-v2"] &&
      jsondecode(aws_cloudwatch_event_rule.workflow_failed["stop-server-v2"].event_pattern).detail["$or"] == [
        { error = [{ "anything-but" = ["Spawnpoint.V2StopRefusedPlayersOnline"] }] },
        { error = [{ exists = false }] },
        { error = [null] },
      ]
    )
    error_message = "The rule must match every failed stop except a refusal for players online, including one with no error."
  }

  assert {
    condition     = aws_cloudwatch_event_target.workflow_failed["stop-server-v2"].rule == "spawnpoint-stop-server-v2-failed"
    error_message = "The rule needs a target to run."
  }
}

run "backup_retention_runs_daily_and_may_delete_only_current_archives" {
  command = plan

  assert {
    condition = alltrue([
      aws_cloudwatch_event_rule.backup_retention.schedule_expression == "cron(30 4 * * ? *)",
      aws_cloudwatch_event_target.backup_retention.rule == aws_cloudwatch_event_rule.backup_retention.name,
      aws_lambda_permission.backup_retention.principal == "events.amazonaws.com",
      aws_lambda_function.backup_retention.environment[0].variables["BACKUP_BUCKET"] == "spawnpoint-backups-123456789012",
      aws_lambda_function.backup_retention.environment[0].variables["RELEASE_BUCKET"] == "spawnpoint-releases-123456789012",
    ])
    error_message = "Retention runs once a day against the backup bucket and reads world records from the release bucket."
  }

  assert {
    condition = alltrue([
      one([for statement in data.aws_iam_policy_document.backup_retention.statement : statement.actions if statement.sid == "DeleteOnlyArchives"]) == toset(["s3:DeleteObject"]),
      one([for statement in data.aws_iam_policy_document.backup_retention.statement : statement.resources if statement.sid == "DeleteOnlyArchives"]) == toset(["arn:aws:s3:::spawnpoint-backups-123456789012/worlds/*/archives/*"]),
    ])
    error_message = "Retention may delete a current archive version, never a version and never outside the archive prefix."
  }

  assert {
    condition     = alltrue([for statement in data.aws_iam_policy_document.backup_retention.statement : !contains(statement.actions, "s3:DeleteObjectVersion")])
    error_message = "Retention must never delete a version; the 30-day noncurrent version is the safety net."
  }

  assert {
    condition     = one([for statement in data.aws_iam_policy_document.backup_retention.statement : statement.resources if statement.sid == "ReadWorldRecords"]) == toset(["arn:aws:s3:::spawnpoint-releases-123456789012/worlds/*/world.json"])
    error_message = "Retention reads world records through this statement and nothing else."
  }

  assert {
    condition     = one([for statement in data.aws_iam_policy_document.backup_retention.statement : statement.resources if statement.sid == "ReadPrePromotionBackups"]) == toset(["arn:aws:s3:::spawnpoint-releases-123456789012/worlds/*/generations/*/release.json"])
    error_message = "Retention reads each wipe's pointer for its pre-promotion backup, and nothing else in the release bucket."
  }

  assert {
    condition     = toset(one(one([for statement in data.aws_iam_policy_document.backup_retention.statement : statement.condition if statement.sid == "ListWorldArchives"])).values) == toset(["worlds/", "worlds/*/archives/*"])
    error_message = "Retention lists the world prefixes and their archives only."
  }

  assert {
    condition = alltrue([
      aws_cloudwatch_metric_alarm.backup_retention_failed.metric_name == "Errors",
      aws_cloudwatch_metric_alarm.backup_retention_failed.dimensions.FunctionName == "spawnpoint-backup-retention",
      contains(aws_cloudwatch_metric_alarm.backup_retention_failed.alarm_actions, "arn:aws:sns:eu-central-1:123456789012:spawnpoint-alert"),
    ])
    error_message = "A failed retention run must alarm the guardrails topic."
  }
}

run "release_reconciler_reads_and_runs_weekly" {
  command = plan

  assert {
    condition = alltrue([
      aws_iam_role.release_reconciler.name == "spawnpoint-release-reconciler",
      aws_lambda_function.release_reconciler.function_name == "spawnpoint-release-reconciler",
      aws_lambda_function.release_reconciler.runtime == "nodejs22.x",
      aws_lambda_function.release_reconciler.timeout == 900,
      aws_lambda_function.release_reconciler.memory_size == 512,
      aws_lambda_function.release_reconciler.environment[0].variables["RELEASE_BUCKET"] == "spawnpoint-releases-123456789012",
      aws_lambda_function.release_reconciler.environment[0].variables["BACKUP_BUCKET"] == "spawnpoint-backups-123456789012",
      aws_lambda_function.release_reconciler.environment[0].variables["RELEASE_REFS_TABLE"] == "spawnpoint-release-refs",
      aws_cloudwatch_log_group.release_reconciler.retention_in_days == 30,
    ])
    error_message = "The reconciler is the named role and Lambda, with the two buckets and the reference table."
  }

  assert {
    condition = alltrue([
      aws_cloudwatch_event_rule.release_reconciler_weekly.name == "spawnpoint-release-reconciler-weekly",
      aws_cloudwatch_event_rule.release_reconciler_weekly.schedule_expression == "cron(0 5 ? * SUN *)",
      aws_cloudwatch_event_target.release_reconciler_weekly.rule == aws_cloudwatch_event_rule.release_reconciler_weekly.name,
      aws_lambda_permission.release_reconciler_weekly.principal == "events.amazonaws.com",
    ])
    error_message = "The reconciler runs once a week, on Sunday morning."
  }

  # The exact list of actions. A new action needs a change here, in review.
  assert {
    condition = toset(flatten([for statement in data.aws_iam_policy_document.release_reconciler.statement : tolist(statement.actions)])) == toset([
      "s3:ListBucket", "s3:ListBucketVersions", "s3:GetObject", "s3:GetObjectVersion",
      "dynamodb:GetItem", "dynamodb:Query", "dynamodb:Scan",
      "s3:DeleteObject", "dynamodb:UpdateItem", "dynamodb:PutItem",
      "cloudwatch:PutMetricData",
    ])
    error_message = "The reconciler may list, get, read the table, put metrics, delete one object, and update or put one table item, and nothing else."
  }

  assert {
    condition = alltrue([
      for action in flatten([for statement in data.aws_iam_policy_document.release_reconciler.statement : tolist(statement.actions)]) :
      action != "s3:DeleteObjectVersion" && !startswith(action, "s3:Put") && !startswith(action, "s3:Restore") &&
      action != "s3:DeleteObjects" && action != "s3:DeleteBucket" &&
      action != "dynamodb:DeleteItem" && !startswith(action, "dynamodb:Batch") && !startswith(action, "dynamodb:Transact")
    ])
    error_message = "The sweep has no version delete, no s3:Put*, no table delete, batch or transaction."
  }

  assert {
    condition = alltrue([
      one([for statement in data.aws_iam_policy_document.release_reconciler.statement : statement.resources if statement.sid == "ReadReferenceTable"]) == toset([
        "arn:aws:dynamodb:eu-central-1:123456789012:table/spawnpoint-release-refs",
        "arn:aws:dynamodb:eu-central-1:123456789012:table/spawnpoint-release-refs/index/*",
      ]),
      one([for statement in data.aws_iam_policy_document.release_reconciler.statement : statement.resources if statement.sid == "ReadReleaseSources"]) == toset([
        "arn:aws:s3:::spawnpoint-releases-123456789012/releases/*",
        "arn:aws:s3:::spawnpoint-releases-123456789012/worlds/*",
        "arn:aws:s3:::spawnpoint-releases-123456789012/presets/*",
      ]),
      one([for statement in data.aws_iam_policy_document.release_reconciler.statement : statement.resources if statement.sid == "ReadArchiveMetadata"]) == toset(["arn:aws:s3:::spawnpoint-backups-123456789012/worlds/*/archives/*"]),
      toset(one(one([for statement in data.aws_iam_policy_document.release_reconciler.statement : statement.condition if statement.sid == "ListReleaseBucket"])).values) == toset(["releases/", "objects/sha256/", "worlds/", "worlds/*", "presets/"]),
    ])
    error_message = "The reconciler reads the reference table, three release prefixes and archive metadata, and lists four prefixes. It never reads objects/."
  }

  assert {
    condition = alltrue([
      one(one([for statement in data.aws_iam_policy_document.release_reconciler.statement : statement.condition if statement.sid == "PutReconcilerMetrics"])).test == "StringEquals",
      one(one([for statement in data.aws_iam_policy_document.release_reconciler.statement : statement.condition if statement.sid == "PutReconcilerMetrics"])).variable == "cloudwatch:namespace",
      toset(one(one([for statement in data.aws_iam_policy_document.release_reconciler.statement : statement.condition if statement.sid == "PutReconcilerMetrics"])).values) == toset(["Spawnpoint/ReleaseReconciler"]),
    ])
    error_message = "PutMetricData is allowed in the reconciler's own namespace only."
  }

  assert {
    condition = alltrue([
      aws_cloudwatch_metric_alarm.release_reconciler_dangerous_diff.alarm_name == "spawnpoint-release-reconciler-dangerous-diff",
      aws_cloudwatch_metric_alarm.release_reconciler_dangerous_diff.metric_name == "DangerousDiff",
      aws_cloudwatch_metric_alarm.release_reconciler_missing_object.alarm_name == "spawnpoint-release-reconciler-missing-object",
      aws_cloudwatch_metric_alarm.release_reconciler_missing_object.metric_name == "MissingObject",
      aws_cloudwatch_metric_alarm.release_reconciler_run_failed.alarm_name == "spawnpoint-release-reconciler-run-failed",
      aws_cloudwatch_metric_alarm.release_reconciler_run_failed.metric_name == "RunFailed",
      aws_cloudwatch_metric_alarm.release_reconciler_incomplete.alarm_name == "spawnpoint-release-reconciler-incomplete",
      aws_cloudwatch_metric_alarm.release_reconciler_incomplete.metric_name == "Incomplete",
      alltrue([for alarm in [
        aws_cloudwatch_metric_alarm.release_reconciler_incomplete,
        aws_cloudwatch_metric_alarm.release_reconciler_dangerous_diff,
        aws_cloudwatch_metric_alarm.release_reconciler_missing_object,
        aws_cloudwatch_metric_alarm.release_reconciler_run_failed,
        ] : alarm.namespace == "Spawnpoint/ReleaseReconciler" && alarm.statistic == "Maximum" && alarm.period == 86400 &&
        alarm.threshold == 0 && alarm.comparison_operator == "GreaterThanThreshold" && alarm.treat_missing_data == "notBreaching" &&
        contains(alarm.alarm_actions, "arn:aws:sns:eu-central-1:123456789012:spawnpoint-alert") &&
      contains(alarm.ok_actions, "arn:aws:sns:eu-central-1:123456789012:spawnpoint-alert")]),
    ])
    error_message = "Dangerous diff, missing object, an incomplete run and a failed run each alarm the guardrails topic, on a one-day window that survives a weekly metric."
  }

  assert {
    condition = alltrue([
      aws_cloudwatch_metric_alarm.release_reconciler_errors.metric_name == "Errors",
      aws_cloudwatch_metric_alarm.release_reconciler_errors.dimensions.FunctionName == "spawnpoint-release-reconciler",
      contains(aws_cloudwatch_metric_alarm.release_reconciler_errors.alarm_actions, "arn:aws:sns:eu-central-1:123456789012:spawnpoint-alert"),
    ])
    error_message = "A Lambda error in the reconciler must alarm the guardrails topic."
  }
}

run "release_reconciler_sweep_is_narrow_and_dry_by_default" {
  command = plan

  assert {
    condition = alltrue([
      var.release_sweep_dry_run == true,
      aws_lambda_function.release_reconciler.environment[0].variables["RELEASE_SWEEP_DRY_RUN"] == "true",
    ])
    error_message = "The sweep is a dry run unless release_sweep_dry_run is set to false."
  }

  assert {
    condition = alltrue([
      toset(one([for statement in data.aws_iam_policy_document.release_reconciler.statement : statement.actions if statement.sid == "SweepDeleteObjects"])) == toset(["s3:DeleteObject"]),
      one([for statement in data.aws_iam_policy_document.release_reconciler.statement : statement.resources if statement.sid == "SweepDeleteObjects"]) == toset(["arn:aws:s3:::spawnpoint-releases-123456789012/objects/*"]),
      toset(one([for statement in data.aws_iam_policy_document.release_reconciler.statement : statement.actions if statement.sid == "SweepWriteFileItems"])) == toset(["dynamodb:UpdateItem", "dynamodb:PutItem"]),
      one([for statement in data.aws_iam_policy_document.release_reconciler.statement : statement.resources if statement.sid == "SweepWriteFileItems"]) == toset(["arn:aws:dynamodb:eu-central-1:123456789012:table/spawnpoint-release-refs"]),
    ])
    error_message = "DeleteObject is on objects/* only. Table writes are on the reference table itself, never on an index."
  }

  assert {
    condition = alltrue([
      one(one([for statement in data.aws_iam_policy_document.release_reconciler.statement : statement.condition if statement.sid == "SweepWriteFileItems"])).test == "ForAllValues:StringLike",
      one(one([for statement in data.aws_iam_policy_document.release_reconciler.statement : statement.condition if statement.sid == "SweepWriteFileItems"])).variable == "dynamodb:LeadingKeys",
      toset(one(one([for statement in data.aws_iam_policy_document.release_reconciler.statement : statement.condition if statement.sid == "SweepWriteFileItems"])).values) == toset(["file#*"]),
    ])
    error_message = "Table writes are limited to file items by their leading key."
  }

  assert {
    condition = alltrue([
      aws_cloudwatch_metric_alarm.release_reconciler_sweep_failed.alarm_name == "spawnpoint-release-reconciler-sweep-failed",
      aws_cloudwatch_metric_alarm.release_reconciler_sweep_failed.namespace == "Spawnpoint/ReleaseReconciler",
      aws_cloudwatch_metric_alarm.release_reconciler_sweep_failed.metric_name == "SweepFailed",
      aws_cloudwatch_metric_alarm.release_reconciler_sweep_failed.statistic == "Maximum",
      aws_cloudwatch_metric_alarm.release_reconciler_sweep_failed.period == 86400,
      aws_cloudwatch_metric_alarm.release_reconciler_sweep_failed.threshold == 0,
      aws_cloudwatch_metric_alarm.release_reconciler_sweep_failed.comparison_operator == "GreaterThanThreshold",
      aws_cloudwatch_metric_alarm.release_reconciler_sweep_failed.treat_missing_data == "notBreaching",
      contains(aws_cloudwatch_metric_alarm.release_reconciler_sweep_failed.alarm_actions, "arn:aws:sns:eu-central-1:123456789012:spawnpoint-alert"),
      contains(aws_cloudwatch_metric_alarm.release_reconciler_sweep_failed.ok_actions, "arn:aws:sns:eu-central-1:123456789012:spawnpoint-alert"),
    ])
    error_message = "A failed sweep write alarms the guardrails topic on a one-day window."
  }
}

run "release_reconciler_sweep_can_be_turned_on" {
  command = plan

  variables {
    release_sweep_dry_run = false
  }

  assert {
    condition     = aws_lambda_function.release_reconciler.environment[0].variables["RELEASE_SWEEP_DRY_RUN"] == "false"
    error_message = "release_sweep_dry_run = false reaches the Lambda as the string false, the only value that turns the dry run off."
  }
}

run "release_state_holds_release_items_and_never_file_items" {
  command = plan

  assert {
    condition = alltrue([
      aws_lambda_function.release_state.environment[0].variables["RELEASE_REFS_TABLE"] == "spawnpoint-release-refs",
      aws_lambda_function.release_state.environment[0].variables["RELEASE_BUCKET"] == "spawnpoint-releases-123456789012",
    ])
    error_message = "The release-state Lambda names the reference table and the release bucket."
  }

  assert {
    condition = alltrue([
      one([for statement in data.aws_iam_policy_document.release_state.statement : statement.actions if statement.sid == "HoldReleaseState"]) == toset(["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem"]),
      one([for statement in data.aws_iam_policy_document.release_state.statement : statement.resources if statement.sid == "HoldReleaseState"]) == toset(["arn:aws:dynamodb:eu-central-1:123456789012:table/spawnpoint-release-refs"]),
      one(one([for statement in data.aws_iam_policy_document.release_state.statement : statement.condition if statement.sid == "HoldReleaseState"])).test == "ForAllValues:StringLike",
      one(one([for statement in data.aws_iam_policy_document.release_state.statement : statement.condition if statement.sid == "HoldReleaseState"])).variable == "dynamodb:LeadingKeys",
      toset(one(one([for statement in data.aws_iam_policy_document.release_state.statement : statement.condition if statement.sid == "HoldReleaseState"])).values) == toset(["release#*"]),
    ])
    error_message = "A transition may get, put and update release items and holders (leading key release#*), and nothing else in the table."
  }

  assert {
    condition = alltrue([
      for action in flatten([for statement in data.aws_iam_policy_document.release_state.statement : tolist(statement.actions)]) :
      !startswith(action, "dynamodb:Delete") && !startswith(action, "dynamodb:Batch") && !startswith(action, "dynamodb:Scan") && !startswith(action, "dynamodb:Query")
    ])
    error_message = "The release-state Lambda cannot delete, batch, scan or query the table, so it cannot write a file# item or remove a holder."
  }

  assert {
    condition = alltrue([
      one([for statement in data.aws_iam_policy_document.release_state.statement : statement.actions if statement.sid == "ReadWorldRecordForHolder"]) == toset(["s3:GetObject"]),
      one([for statement in data.aws_iam_policy_document.release_state.statement : statement.resources if statement.sid == "ReadWorldRecordForHolder"]) == toset(["arn:aws:s3:::spawnpoint-releases-123456789012/worlds/*/world.json"]),
    ])
    error_message = "The release-state Lambda reads world records, and only them, to find the game and preset of a pointer."
  }
}

# ADR-0100: with no persistent host left, the host rules stay in place and match no instance.
run "host_rules_outlive_a_deleted_persistent_host" {
  command = plan

  override_data {
    target = data.aws_instances.persistent_host
    values = { ids = [] }
  }

  assert {
    condition     = jsondecode(aws_cloudwatch_event_rule.control_plane_host_state.event_pattern).detail["instance-id"] == ["i-00000000000000000"]
    error_message = "A deleted persistent host must leave the rule in place, matching no instance, rather than delete it."
  }
}

# ADR-0100: the delete-host machine reaches only the persistent host, its data volume and Spawnpoint's alarms.
run "delete_host_reaches_only_spawnpoint_resources" {
  command = plan

  assert {
    condition = alltrue([
      for statement in data.aws_iam_policy_document.delete_host.statement :
      anytrue([for condition in statement.condition : condition.variable == "ec2:ResourceTag/Name" && contains(condition.values, "spawnpoint-game-host")])
      if contains(statement.actions, "ec2:TerminateInstances")
    ])
    error_message = "Only an instance named spawnpoint-game-host may be terminated."
  }

  assert {
    condition = alltrue([
      for statement in data.aws_iam_policy_document.delete_host.statement :
      anytrue([for condition in statement.condition : condition.variable == "ec2:ResourceTag/Name" && contains(condition.values, "spawnpoint-data")])
      if contains(statement.actions, "ec2:DeleteVolume")
    ])
    error_message = "Only a volume named spawnpoint-data may be deleted."
  }

  assert {
    condition = (
      aws_sfn_state_machine.delete_host.type == "STANDARD"
      && contains([for machine in local.control_plane_operation_machines : machine.type], "host")
      && strcontains(aws_sfn_state_machine.delete_host.definition, "arn:aws:states:::aws-sdk:ec2:createSnapshot")
    )
    error_message = "Deleting a host is a tracked operation that can keep a snapshot first."
  }
}

run "session_volume_is_off_by_default_and_reached_only_by_its_tag" {
  command = plan

  assert {
    condition = alltrue([
      var.session_volume == "disabled",
      jsondecode(aws_sfn_state_machine.lifecycle_v2_start.definition).States["Initialize"].Parameters.sessionVolume.mode == "disabled",
      jsondecode(aws_sfn_state_machine.lifecycle_v2_stop.definition).States["Initialize"].Parameters.sessionVolume.mode == "disabled",
    ])
    error_message = "The session volume is off unless SPAWNPOINT_SESSION_VOLUME turns it on (ADR-0102)."
  }

  assert {
    condition = alltrue([
      jsondecode(aws_sfn_state_machine.lifecycle_v2_start.definition).States["Create Session Volume"].Parameters["Size.$"] == "States.StringToJson('30')",
      jsondecode(aws_sfn_state_machine.lifecycle_v2_start.definition).States["Create Session Volume"].Parameters.TagSpecifications[0].Tags[0].Value == local.session_volume_managed_by,
      jsondecode(aws_sfn_state_machine.lifecycle_v2_stop.definition).States["Find Session Volume"].Parameters.Filters[1].Name == "tag:${local.session_volume_session_tag}",
    ])
    error_message = "The volume size comes from session_volume_size_gib, and the workflows tag and find the volume by the one set of tag values."
  }

  assert {
    condition = alltrue([
      for sid in ["CreateTaggedSessionVolumes", "TagSessionVolumesAtCreation"] :
      anytrue([for statement in data.aws_iam_policy_document.session_volume_create.statement : statement.sid == sid && anytrue([for condition in statement.condition : condition.variable == "aws:RequestTag/ManagedBy" && contains(condition.values, "spawnpoint-session-volume")])])
    ])
    error_message = "A session volume can be created only with its ManagedBy tag."
  }

  assert {
    condition = alltrue(concat(
      [for statement in data.aws_iam_policy_document.session_volume_create.statement :
        anytrue([for condition in statement.condition : condition.variable == "ec2:ResourceTag/ManagedBy"])
      if contains(tolist(statement.actions), "ec2:AttachVolume")],
      [for statement in data.aws_iam_policy_document.session_volume_release.statement :
        anytrue([for condition in statement.condition : condition.variable == "ec2:ResourceTag/ManagedBy"])
      if contains(tolist(statement.actions), "ec2:DetachVolume") || contains(tolist(statement.actions), "ec2:DeleteVolume")],
    ))
    error_message = "Attach, detach and delete reach only tagged volumes and tagged launched hosts."
  }

  assert {
    condition     = one([for statement in data.aws_iam_policy_document.session_volume_release.statement : statement.resources if statement.sid == "UnmountThroughItsDocument"]) == toset(["arn:aws:ssm:eu-central-1:123456789012:document/spawnpoint-unmount-session-volume"])
    error_message = "The unmount runs only through its own document."
  }
}

run "session_volume_can_be_switched_on" {
  command = plan

  variables {
    session_volume          = "enabled"
    session_volume_size_gib = 50
  }

  assert {
    condition = alltrue([
      jsondecode(aws_sfn_state_machine.lifecycle_v2_start.definition).States["Initialize"].Parameters.sessionVolume.mode == "enabled",
      jsondecode(aws_sfn_state_machine.lifecycle_v2_start.definition).States["Create Session Volume"].Parameters["Size.$"] == "States.StringToJson('50')",
    ])
    error_message = "The switch and the size reach the start workflow."
  }
}

run "session_volume_size_is_bounded" {
  command = plan

  variables {
    session_volume_size_gib = 0
  }

  expect_failures = [var.session_volume_size_gib]
}
