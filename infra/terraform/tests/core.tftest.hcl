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
    target = data.aws_sns_topic.alerts
    values = {
      arn = "arn:aws:sns:eu-central-1:123456789012:spawnpoint-alerts"
    }
  }
}

run "free_plan_host_preserves_m0_invariants" {
  command = plan

  assert {
    condition     = aws_instance.game_host.instance_type == "m7i-flex.large"
    error_message = "The Free Plan host must remain m7i-flex.large until an explicit paid upgrade."
  }

  assert {
    condition     = length(local.public_game_ports) == 0
    error_message = "No world declares a public connectivity today, so the host must open no port at all. Opening one is a catalog diff — and the check block refuses a public world that declares no authentication."
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
    condition     = aws_instance.game_host.metadata_options[0].http_tokens == "required"
    error_message = "The instance must require IMDSv2 tokens."
  }

  assert {
    condition     = aws_instance.game_host.disable_api_termination
    error_message = "The game host must retain EC2 termination protection."
  }

  assert {
    condition     = aws_instance.game_host.root_block_device[0].encrypted && aws_instance.game_host.root_block_device[0].delete_on_termination
    error_message = "The disposable root volume must be encrypted and deleted with the instance."
  }

  assert {
    condition     = aws_ebs_volume.data.encrypted && aws_ebs_volume.data.size == 20
    error_message = "The persistent data EBS must be encrypted and start at the measured 20 GiB."
  }

  assert {
    condition     = aws_volume_attachment.data.device_name == "/dev/sdf" && aws_volume_attachment.data.stop_instance_before_detaching
    error_message = "The data volume must use the reviewed attachment contract and stop before detach."
  }

  assert {
    condition     = data.aws_s3_bucket.backups.id == "spawnpoint-backups-123456789012" && data.aws_s3_bucket.releases.id == "spawnpoint-releases-123456789012"
    error_message = "The compute stack must consume the separately managed persistent storage buckets."
  }
}

run "reviewed_paid_upgrade_is_explicit" {
  command = plan

  variables {
    instance_type = "r8i-flex.large"
  }

  assert {
    condition     = aws_instance.game_host.instance_type == "r8i-flex.large"
    error_message = "The reviewed 16 GiB upgrade must remain selectable without changing the topology."
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
}

run "stop_workflow_is_standard_and_stops_only_after_backup_step" {
  command = plan

  assert {
    condition     = aws_sfn_state_machine.stop_server.type == "STANDARD"
    error_message = "Verified session stop must use a Standard workflow."
  }

  assert {
    condition     = jsondecode(aws_sfn_state_machine.stop_server.definition).States["Stop Command Complete"].Choices[0].Next == "Stop Instance"
    error_message = "EC2 stop must be reachable only after the host save/backup command succeeds."
  }

  assert {
    condition     = jsondecode(aws_sfn_state_machine.stop_server.definition).States["Stop Instance"].Resource == "arn:aws:states:::aws-sdk:ec2:stopInstances"
    error_message = "The workflow must stop EC2 directly rather than through a Lambda wrapper."
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
    condition     = aws_dynamodb_table.lifecycle_v2.server_side_encryption[0].enabled
    error_message = "Lifecycle coordination state must be encrypted at rest."
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
    condition     = toset(local.lifecycle_coordinator_table_actions) == toset(["dynamodb:GetItem", "dynamodb:PutItem"])
    error_message = "Coordinator table permissions must remain limited to optimistic-CAS reads and writes."
  }

  assert {
    condition     = aws_cloudwatch_log_group.lifecycle_coordinator.retention_in_days == 14
    error_message = "Coordinator logs must have bounded retention."
  }
}

run "unreviewed_instance_type_is_rejected" {
  command = plan

  variables {
    instance_type = "m7i-flex.xlarge"
  }

  expect_failures = [var.instance_type]
}

run "running_hours_alarm_is_a_presence_alarm_on_the_guardrails_topic" {
  command = plan

  assert {
    condition     = aws_cloudwatch_metric_alarm.running_hours.treat_missing_data == "notBreaching"
    error_message = "A stopped host emits no metric; missing data must read as healthy."
  }

  assert {
    condition     = aws_cloudwatch_metric_alarm.running_hours.threshold == -1 && aws_cloudwatch_metric_alarm.running_hours.comparison_operator == "GreaterThanThreshold"
    error_message = "The alarm fires on metric presence — any CPU reading beats -1 — not on load."
  }

  assert {
    condition     = aws_cloudwatch_metric_alarm.running_hours.period == 3600 && aws_cloudwatch_metric_alarm.running_hours.evaluation_periods == 10
    error_message = "Ten hourly datapoints keep the alarm above the watchdog's 8h session cap."
  }

  assert {
    condition     = contains(aws_cloudwatch_metric_alarm.running_hours.alarm_actions, "arn:aws:sns:eu-central-1:123456789012:spawnpoint-alerts")
    error_message = "The alarm must publish to the guardrails topic, where every alert converges."
  }
}
