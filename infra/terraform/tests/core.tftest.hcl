mock_provider "aws" {
  override_during = plan

  override_data {
    target = data.aws_availability_zone.selected
    values = {
      name    = "eu-central-1a"
      zone_id = "euc1-az2"
    }
  }

  override_data {
    target = data.aws_ssm_parameter.amazon_linux_2023_ami
    values = {
      value = "ami-00000000000000000"
    }
  }

  override_data {
    target = data.aws_caller_identity.current
    values = {
      account_id = "123456789012"
    }
  }

  override_data {
    target = data.aws_s3_bucket.backups
    values = {
      id  = "spawnpoint-backups-123456789012"
      arn = "arn:aws:s3:::spawnpoint-backups-123456789012"
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
    target = data.aws_iam_policy_document.ec2_assume_role
    values = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}"
    }
  }

  override_data {
    target = data.aws_iam_policy_document.game_host_storage
    values = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}"
    }
  }

  override_data {
    target = data.aws_iam_policy_document.game_host_session_logs
    values = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}"
    }
  }
  override_data {
    target = data.aws_iam_policy_document.game_host_interruption_report
    values = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}"
    }
  }

  override_data {
    target = data.aws_iam_policy_document.step_functions_assume_role
    values = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}"
    }
  }

  override_data {
    target = data.aws_iam_policy_document.start_workflow
    values = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}"
    }
  }

  override_data {
    target = data.aws_iam_policy_document.stop_workflow
    values = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}"
    }
  }

  override_data {
    target = data.aws_iam_policy_document.lambda_assume_role
    values = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}"
    }
  }

  override_data {
    target = data.aws_iam_policy_document.lifecycle_coordinator
    values = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}"
    }
  }

  override_data {
    target = data.aws_iam_policy_document.game_host_parameters
    values = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}"
    }
  }

  override_data {
    target = data.aws_sns_topic.alerts
    values = {
      arn = "arn:aws:sns:eu-central-1:123456789012:spawnpoint-alert"
    }
  }
}

run "persistent_host_network_and_storage_contracts_hold" {
  command = plan

  # ADR-0085: the persistent host opens each game module's own port and the
  # slot range, and nothing else. What listens on them is decided per session
  # (server/tests/compose-bindings-test.sh).
  assert {
    condition = (
      length(aws_security_group.game_host.ingress) == length(local.fleet_game_ports) + 2
      && alltrue([for module in values(local.fleet_game_ports) : anytrue([
        for rule in aws_security_group.game_host.ingress : rule.from_port == module.port && rule.to_port == module.port && rule.protocol == module.protocol
      ])])
      && alltrue([for protocol in ["tcp", "udp"] : anytrue([
        for rule in aws_security_group.game_host.ingress : rule.from_port == 30010 && rule.to_port == 32559 && rule.protocol == protocol
      ])])
    )
    error_message = "The persistent host opens exactly the game modules' own ports and the slot range (ADR-0085)."
  }

  # The mechanism itself: a world that does declare one must produce exactly one
  # rule, on its own game's port, read from that game's module.
  assert {
    condition = length([
      for world in local.public_worlds : world
      if !contains(["external", "game"], world.auth)
    ]) == 0
    error_message = "A public world without a declared auth model would open a port the host then refuses to start."
  }

  assert {
    condition = local.game_host_release_resources == [
      "arn:aws:s3:::spawnpoint-releases-123456789012/releases/*",
      "arn:aws:s3:::spawnpoint-releases-123456789012/objects/*",
      "arn:aws:s3:::spawnpoint-releases-123456789012/worlds/*",
    ]
    error_message = "The host must be able to read immutable releases, their content-addressed objects and dynamically materialized world records."
  }

  assert {
    condition     = data.aws_s3_bucket.backups.id == "spawnpoint-backups-123456789012" && data.aws_s3_bucket.releases.id == "spawnpoint-releases-123456789012"
    error_message = "The compute stack must consume the separately managed persistent storage buckets."
  }
}

run "start_workflow_is_standard_and_uses_direct_integrations" {
  command = plan

  assert {
    condition     = aws_sfn_state_machine.start_server.type == "STANDARD"
    error_message = "Long-running session start must use a Standard workflow."
  }

  assert {
    condition     = jsondecode(aws_sfn_state_machine.start_server.definition).States["Start Instance"].Resource == "arn:aws:states:::aws-sdk:ec2:startInstances"
    error_message = "The workflow must start EC2 directly rather than paying for a Lambda wrapper."
  }

  assert {
    condition     = jsondecode(aws_sfn_state_machine.start_server.definition).States["Start Session Command"].Resource == "arn:aws:states:::aws-sdk:ssm:sendCommand"
    error_message = "The workflow must invoke the host through SSM directly."
  }

  assert {
    condition     = strcontains(aws_ssm_document.start_session.content, "SESSION_FORMAT=json") && strcontains(aws_sfn_state_machine.start_server.definition, "$.session.summary.connection_address")
    error_message = "The start machine must ask the host for a JSON session summary and carry its address back."
  }

  assert {
    condition     = !strcontains(aws_sfn_state_machine.start_server.definition, "$.request.connectionAddress")
    error_message = "No state may echo a caller-supplied address: a public world's address does not exist before the start."
  }

  assert {
    condition = alltrue([
      for state in ["Start Fleet Session Command", "Start Placed Session Command", "Start Session Command"] :
      jsondecode(aws_sfn_state_machine.start_server.definition).States[state].Parameters.CloudWatchOutputConfig.CloudWatchOutputEnabled == true
      && jsondecode(aws_sfn_state_machine.start_server.definition).States[state].Parameters.CloudWatchOutputConfig.CloudWatchLogGroupName == aws_cloudwatch_log_group.session_commands.name
    ])
    error_message = "Every session command must send its output to the session command log group: a failed start terminates the host that holds the only other copy."
  }

  assert {
    condition     = aws_cloudwatch_log_group.session_commands.retention_in_days == 14
    error_message = "Session command output must expire: it holds a failed start's whole console, and nothing reads it a fortnight later."
  }
}

run "host_steps_pass_values_only_through_checked_document_parameters" {
  command = plan

  assert {
    condition = alltrue(flatten([
      for document in [aws_ssm_document.start_session, aws_ssm_document.stop_session] : [
        jsondecode(document.content).parameters.worldId.allowedPattern == "^[a-z0-9][a-z0-9-]{0,31}$",
        jsondecode(document.content).parameters.slot.allowedPattern == "^([0-9]{1,3})?$",
        length(jsondecode(document.content).mainSteps) == 1,
      ]
    ]))
    error_message = "SSM must refuse a world id or slot that could carry shell syntax, before any shell on the host reads it (ADR-0082)."
  }

  assert {
    condition     = jsondecode(aws_ssm_document.stop_session.content).parameters.players.allowedValues == ["refuse", "disconnect"]
    error_message = "The players policy reaches the host only as one of the two values ADR-0081 defines."
  }

  assert {
    condition = alltrue(concat(
      [for state in ["Start Fleet Session Command", "Start Placed Session Command", "Start Session Command"] :
        jsondecode(aws_sfn_state_machine.start_server.definition).States[state].Parameters.DocumentName == aws_ssm_document.start_session.name
        && !contains(keys(jsondecode(aws_sfn_state_machine.start_server.definition).States[state].Parameters.Parameters), "commands.$")
      ],
      [for state in ["Stop Placed Session Command", "Stop Session Command"] :
        jsondecode(aws_sfn_state_machine.stop_server.definition).States[state].Parameters.DocumentName == aws_ssm_document.stop_session.name
        && !contains(keys(jsondecode(aws_sfn_state_machine.stop_server.definition).States[state].Parameters.Parameters), "commands.$")
      ],
    ))
    error_message = "Every host step sends its own document with named parameters, never a shell line built from the request."
  }

  assert {
    condition     = jsondecode(aws_ssm_document.start_session.content).mainSteps[0].name == "startSession" && jsondecode(aws_ssm_document.stop_session.content).mainSteps[0].name == "stopSession"
    error_message = "The step names are the CloudWatch stream names the operation log reader opens; rename them there too."
  }

  assert {
    condition = alltrue([
      for document in [aws_ssm_document.start_session, aws_ssm_document.stop_session] :
      anytrue([for line in jsondecode(document.content).mainSteps[0].inputs.runCommand : strcontains(line, "SPAWNPOINT_INSTANCE_ID") && strcontains(line, "AWS_SSM_INSTANCE_ID")])
      && !anytrue([for line in jsondecode(document.content).mainSteps[0].inputs.runCommand : strcontains(line, "SPAWNPOINT_DNS_ZONE_ID")])
    ])
    error_message = "The host steps carry the instance id from the SSM agent, and DNS settings only when the deployment has a DNS zone (ADR-0085)."
  }

  assert {
    condition = (
      strcontains(jsondecode(aws_ssm_document.start_session.content).mainSteps[0].inputs.runCommand[2], "update-checkout.sh")
      && strcontains(jsondecode(aws_ssm_document.start_session.content).mainSteps[0].inputs.runCommand[2], ">&2 || true")
      && strcontains(element(jsondecode(aws_ssm_document.start_session.content).mainSteps[0].inputs.runCommand, length(jsondecode(aws_ssm_document.start_session.content).mainSteps[0].inputs.runCommand) - 1), "start-session.sh")
    )
    error_message = "Every start first brings the host's checkout to the deployed commit, writing to standard error and never failing for it: the session summary is read from standard output."
  }

  assert {
    condition     = strcontains(jsondecode(aws_ssm_document.start_session.content).mainSteps[0].inputs.runCommand[1], "/etc/spawnpoint-fleet-ready")
    error_message = "A launched host may register with SSM before its bootstrap finishes; the start waits for the marker when asked to."
  }
}

run "stop_workflow_is_standard_and_stops_only_after_backup_step" {
  command = plan

  assert {
    condition     = aws_sfn_state_machine.stop_server.type == "STANDARD"
    error_message = "Verified session stop must use a Standard workflow."
  }

  assert {
    condition = alltrue([
      jsondecode(aws_sfn_state_machine.stop_server.definition).States["Stop Command Complete"].Choices[0].Next == "Describe Host Market",
      jsondecode(aws_sfn_state_machine.stop_server.definition).States["Describe Host Market"].Next == "Host Is Spot",
      jsondecode(aws_sfn_state_machine.stop_server.definition).States["Host Is Spot"].Default == "Stop Instance",
    ])
    error_message = "EC2 stop must be reachable only after the host save/backup command succeeds, and only for a host that is not Spot (ADR-0102)."
  }

  assert {
    condition     = jsondecode(aws_sfn_state_machine.stop_server.definition).States["Stop Instance"].Resource == "arn:aws:states:::aws-sdk:ec2:stopInstances"
    error_message = "The workflow must stop EC2 directly rather than through a Lambda wrapper."
  }

  assert {
    condition = alltrue([
      for state in ["Stop Placed Session Command", "Stop Session Command"] :
      jsondecode(aws_sfn_state_machine.stop_server.definition).States[state].Parameters.CloudWatchOutputConfig.CloudWatchLogGroupName == aws_cloudwatch_log_group.session_commands.name
    ])
    error_message = "A stop that refuses to archive must leave its reason somewhere other than the host it was about to stop."
  }
}

run "lifecycle_v2_state_is_inert_protected_on_demand_storage" {
  command = plan

  assert {
    condition     = aws_dynamodb_table.lifecycle_v2.billing_mode == "PAY_PER_REQUEST"
    error_message = "The one-item lifecycle table must not reserve read or write capacity."
  }

  assert {
    condition     = aws_dynamodb_table.lifecycle_v2.hash_key == "server_id" && length(aws_dynamodb_table.lifecycle_v2.attribute) == 1
    error_message = "Lifecycle V2 starts with exactly one item per logical server and no speculative indexes."
  }

  assert {
    condition     = aws_dynamodb_table.lifecycle_v2.deletion_protection_enabled
    error_message = "Shared lifecycle state must not disappear during ordinary compute cleanup."
  }

  assert {
    condition     = !aws_dynamodb_table.lifecycle_v2.server_side_encryption[0].enabled
    error_message = "Lifecycle coordination state is encrypted at rest with the AWS owned key, which makes no KMS request (ADR-0101)."
  }

  assert {
    condition     = length(aws_dynamodb_table.lifecycle_v2.ttl) == 0
    error_message = "Lease expiry is a conditional-write fact; DynamoDB TTL must not delete the lifecycle record."
  }
}

run "lifecycle_v2_coordinator_is_small_scoped_and_not_wired_to_v1" {
  command = plan

  assert {
    condition     = aws_lambda_function.lifecycle_coordinator.runtime == "nodejs24.x" && aws_lambda_function.lifecycle_coordinator.handler == "index.handler"
    error_message = "Lifecycle coordinator must use the reviewed Node.js 24 bundle contract."
  }

  assert {
    condition     = aws_lambda_function.lifecycle_coordinator.timeout == 10 && aws_lambda_function.lifecycle_coordinator.memory_size == 128
    error_message = "Coordinator is a short atomic step, not a long-running orchestrator."
  }

  assert {
    condition     = aws_lambda_function.lifecycle_coordinator.environment[0].variables.LIFECYCLE_TABLE_NAME == aws_dynamodb_table.lifecycle_v2.name
    error_message = "Coordinator must target only the Lifecycle V2 table selected by Terraform."
  }

  assert {
    condition     = toset(local.lifecycle_coordinator_table_actions) == toset(["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:Scan"])
    error_message = "Coordinator table permissions must remain limited to optimistic-CAS reads and writes, plus the filtered scan that lists host records."
  }

  assert {
    condition     = aws_cloudwatch_log_group.lifecycle_coordinator.retention_in_days == 14
    error_message = "Coordinator logs must have bounded retention."
  }
}

run "fleet_host_is_a_template_that_names_no_type_and_keeps_nothing" {
  command = plan

  assert {
    condition     = aws_launch_template.fleet_host.instance_type == null || aws_launch_template.fleet_host.instance_type == ""
    error_message = "A launched host's type is EC2's answer to the footprint's requirements (ADR-0054); the template must not name one."
  }

  assert {
    condition     = aws_launch_template.fleet_host.instance_initiated_shutdown_behavior == "terminate"
    error_message = "A launched host holds nothing that outlives a session, so a shutdown is a termination, not a parked volume."
  }

  assert {
    condition     = aws_launch_template.fleet_host.metadata_options[0].http_tokens == "required" && aws_launch_template.fleet_host.metadata_options[0].instance_metadata_tags == "enabled"
    error_message = "A launched host requires IMDSv2 and reads its AppCommit from its own tags."
  }

  assert {
    condition     = local.fleet_host_tags.ManagedBy == "spawnpoint-fleet" && alltrue([for spec in aws_launch_template.fleet_host.tag_specifications : spec.tags.ManagedBy == "spawnpoint-fleet"])
    error_message = "Every launched host carries ManagedBy=spawnpoint-fleet, the tag every statement about launched hosts conditions on."
  }

  assert {
    condition     = aws_launch_template.fleet_host.iam_instance_profile[0].name == aws_iam_instance_profile.game_host.name && tostring(aws_launch_template.fleet_host.network_interfaces[0].associate_public_ip_address) == "true"
    error_message = "A launched host is the same kind of host: the game host's profile, the public subnet, an ephemeral address."
  }
}

run "v1_workflows_alarm_on_failed_and_timed_out_executions" {
  command = plan

  assert {
    condition = toset(keys(aws_cloudwatch_metric_alarm.workflow)) == toset([
      "spawnpoint-start-server-failed",
      "spawnpoint-start-server-timed-out",
      "spawnpoint-stop-server-failed",
      "spawnpoint-stop-server-timed-out",
    ])
    error_message = "Both V1 machines need a failed and a timed-out alarm; a failed V1 stop is the backup-failed signal of ADR-0015."
  }

  assert {
    condition = alltrue([
      for name, alarm in aws_cloudwatch_metric_alarm.workflow :
      (name == "spawnpoint-stop-server-failed" ? alarm.namespace == "AWS/Events" && alarm.metric_name == "MatchedEvents" : alarm.namespace == "AWS/States" && contains(["ExecutionsFailed", "ExecutionsTimedOut"], alarm.metric_name)) &&
      alarm.threshold == 0 && alarm.comparison_operator == "GreaterThanThreshold" &&
      alarm.treat_missing_data == "notBreaching" &&
      alarm.alarm_actions == toset(["arn:aws:sns:eu-central-1:123456789012:spawnpoint-alert"])
    ])
    error_message = "One failed or timed-out execution alarms the guardrails topic; no execution is healthy."
  }
}

run "egress_alarm_sums_every_host" {
  command = plan

  assert {
    condition     = one(aws_cloudwatch_metric_alarm.egress.metric_query).expression == "SELECT SUM(NetworkOut) FROM SCHEMA(\"AWS/EC2\", InstanceId)"
    error_message = "Launched hosts come and go; the egress alarm must sum every host, not name one."
  }

  assert {
    condition = (
      aws_cloudwatch_metric_alarm.egress.threshold == 10 * 1073741824 &&
      one(aws_cloudwatch_metric_alarm.egress.metric_query).period == 3600 &&
      aws_cloudwatch_metric_alarm.egress.treat_missing_data == "notBreaching" &&
      contains(aws_cloudwatch_metric_alarm.egress.alarm_actions, "arn:aws:sns:eu-central-1:123456789012:spawnpoint-alert")
    )
    error_message = "More than 10 GiB in one hour alarms the guardrails topic; no host running is healthy."
  }
}

run "a_stop_refused_for_players_online_does_not_alarm" {
  command = plan

  # The rule's pattern names the machine, whose ARN is otherwise known only after apply.
  override_resource {
    target          = aws_sfn_state_machine.stop_server
    override_during = plan
    values = {
      arn = "arn:aws:states:eu-central-1:123456789012:stateMachine:spawnpoint-stop-server"
    }
  }

  assert {
    condition = (
      aws_cloudwatch_metric_alarm.workflow["spawnpoint-stop-server-failed"].dimensions.RuleName == "spawnpoint-stop-server-failed" &&
      aws_cloudwatch_metric_alarm.workflow["spawnpoint-stop-server-timed-out"].dimensions.StateMachineArn == "arn:aws:states:eu-central-1:123456789012:stateMachine:spawnpoint-stop-server" &&
      aws_cloudwatch_metric_alarm.workflow["spawnpoint-start-server-failed"].namespace == "AWS/States"
    )
    error_message = "Only the stop's failed alarm counts the filtered rule; its timed-out alarm and other machines count AWS/States."
  }

  assert {
    condition = (
      jsondecode(aws_cloudwatch_event_rule.workflow_failed["stop-server"].event_pattern).detail.status == ["FAILED"] &&
      jsondecode(aws_cloudwatch_event_rule.workflow_failed["stop-server"].event_pattern).detail.stateMachineArn == ["arn:aws:states:eu-central-1:123456789012:stateMachine:spawnpoint-stop-server"] &&
      jsondecode(aws_cloudwatch_event_rule.workflow_failed["stop-server"].event_pattern).detail["$or"] == [
        { error = [{ "anything-but" = ["Spawnpoint.PlayersOnline"] }] },
        { error = [{ exists = false }] },
        { error = [null] },
      ]
    )
    error_message = "The rule must match every failed stop except a refusal for players online, including one with no error."
  }

  assert {
    condition     = aws_cloudwatch_event_target.workflow_failed["stop-server"].rule == "spawnpoint-stop-server-failed"
    error_message = "The rule needs a target to run."
  }
}

# The deploy workflows pass the repository they run in.
variables {
  repository_url = "https://github.com/example/spawnpoint.git"
}

run "host_steps_carry_the_dns_settings_when_the_deployment_has_a_zone" {
  command = plan

  variables {
    game_dns_zone_name = "example.com"
    game_dns_suffix    = "games.example.com"
  }

  override_data {
    target = data.aws_route53_zone.game[0]
    values = {
      zone_id = "Z0123456789ABC"
    }
  }

  override_data {
    target = data.aws_iam_policy_document.game_host_dns[0]
    values = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}"
    }
  }

  assert {
    condition = alltrue([
      for document in [aws_ssm_document.start_session, aws_ssm_document.stop_session] :
      anytrue([for line in jsondecode(document.content).mainSteps[0].inputs.runCommand :
        strcontains(line, "SPAWNPOINT_DNS_ZONE_ID='Z0123456789ABC'") && strcontains(line, "SPAWNPOINT_DNS_SUFFIX='games.example.com'") && strcontains(line, "SPAWNPOINT_DNS_LEDGER_TABLE='")
      ])
    ])
    error_message = "The persistent host's environment is not Terraform's, so the host steps carry the deployment's DNS settings (ADR-0085)."
  }
}

# ADR-0100: Terraform lets the persistent host go without destroying it, and
# admits it by its Name tag, so a host the panel deleted breaks no plan.
run "persistent_host_is_admitted_by_tag_never_by_id" {
  command = plan

  assert {
    condition = alltrue([
      for statement in concat(data.aws_iam_policy_document.start_workflow.statement, data.aws_iam_policy_document.stop_workflow.statement) :
      toset(statement.resources) == toset(["arn:aws:ec2:eu-central-1:123456789012:instance/*"])
      && anytrue([for condition in statement.condition : condition.variable == "ec2:ResourceTag/Name" && contains(condition.values, "spawnpoint-game-host")])
      if contains(["StartOnlySpawnpointHost", "StopOnlySpawnpointHost"], statement.sid)
    ])
    error_message = "The persistent host is started and stopped by its Name tag, never by an instance id."
  }

  assert {
    condition = alltrue([
      for document in [data.aws_iam_policy_document.start_workflow, data.aws_iam_policy_document.stop_workflow] : anytrue([
        for statement in document.statement : statement.sid == "RunOnSpawnpointHost" && anytrue([for condition in statement.condition : condition.variable == "ssm:resourceTag/Name" && contains(condition.values, "spawnpoint-game-host")])
      ])
    ])
    error_message = "A host command reaches the persistent host only by its Name tag."
  }
}

run "session_volume_reaches_the_host_only_through_checked_parameters" {
  command = plan

  assert {
    condition = alltrue([
      jsondecode(aws_ssm_document.start_session.content).parameters.sessionVolumeId.allowedPattern == "^(vol-[0-9a-f]{8,17})?$",
      jsondecode(aws_ssm_document.start_session.content).parameters.sessionVolumeId.default == "",
      anytrue([for line in jsondecode(aws_ssm_document.start_session.content).mainSteps[0].inputs.runCommand : strcontains(line, "export SPAWNPOINT_SESSION_VOLUME_ID='{{ sessionVolumeId }}'")]),
      jsondecode(aws_sfn_state_machine.start_server.definition).States["Start Fleet Session Command On Volume"].Parameters.DocumentName == aws_ssm_document.start_session.name,
    ])
    error_message = "A session volume id reaches the host only as a checked document parameter, and an empty one changes nothing (ADR-0102)."
  }

  assert {
    condition = alltrue([
      aws_ssm_document.unmount_session_volume.name == "spawnpoint-unmount-session-volume",
      jsondecode(aws_ssm_document.unmount_session_volume.content).parameters.worldId.allowedPattern == "^[a-z0-9][a-z0-9-]{0,31}$",
      length(keys(jsondecode(aws_ssm_document.unmount_session_volume.content).parameters)) == 1,
    ])
    error_message = "The unmount document takes only a checked world id."
  }
}

run "a_host_reports_interruption_saves_under_its_own_source_only" {
  command = plan

  assert {
    condition     = toset(one([for statement in data.aws_iam_policy_document.game_host_interruption_report.statement : statement.actions])) == toset(["events:PutEvents"])
    error_message = "A game host may only put events."
  }

  assert {
    condition     = toset(one(one([for statement in data.aws_iam_policy_document.game_host_interruption_report.statement : statement.condition])).values) == toset(["spawnpoint.host"])
    error_message = "A game host may only put events under the spawnpoint.host source."
  }
}
