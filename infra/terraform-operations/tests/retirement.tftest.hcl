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
    target = data.aws_sns_topic.fleet_alerts
    values = { arn = "arn:aws:sns:eu-central-1:123456789012:spawnpoint-alert" }
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

run "release_retirement_changes_the_table_and_one_catalog_and_deletes_no_object" {
  command = plan

  assert {
    condition = alltrue([
      aws_iam_role.release_retirement.name == "spawnpoint-release-retirement",
      aws_lambda_function.release_retirement.function_name == "spawnpoint-release-retirement",
      aws_lambda_function.release_retirement.runtime == "nodejs22.x",
      aws_lambda_function.release_retirement.timeout == 900,
      aws_lambda_function.release_retirement.memory_size == 512,
      aws_lambda_function.release_retirement.environment[0].variables["RELEASE_BUCKET"] == "spawnpoint-releases-123456789012",
      aws_lambda_function.release_retirement.environment[0].variables["BACKUP_BUCKET"] == "spawnpoint-backups-123456789012",
      aws_lambda_function.release_retirement.environment[0].variables["RELEASE_REFS_TABLE"] == "spawnpoint-release-refs",
      aws_cloudwatch_log_group.release_retirement.retention_in_days == 30,
    ])
    error_message = "Retirement is the named role and Lambda, with the two buckets and the reference table."
  }

  # Every action must be on this list. Another one needs a change here, in review.
  assert {
    condition = alltrue([
      for action in flatten([for statement in data.aws_iam_policy_document.release_retirement.statement : tolist(statement.actions)]) :
      contains([
        "s3:ListBucket", "s3:ListBucketVersions", "s3:GetObject", "s3:GetObjectVersion", "s3:PutObject",
        "dynamodb:GetItem", "dynamodb:Query", "dynamodb:UpdateItem", "dynamodb:DeleteItem",
      ], action)
    ])
    error_message = "Retirement may list, get, put the catalog and change the reference table, and nothing else."
  }

  assert {
    condition = alltrue([
      for action in flatten([for statement in data.aws_iam_policy_document.release_retirement.statement : tolist(statement.actions)]) :
      !startswith(action, "s3:Delete") && !startswith(action, "s3:Restore") && !startswith(action, "s3:Replicate") && !startswith(action, "dynamodb:Batch") && !startswith(action, "dynamodb:Scan")
    ])
    error_message = "Retirement has no s3:Delete*: only the reconciler role may delete an object."
  }

  # s3:Put* only on the preset catalogs.
  assert {
    condition = alltrue([
      for statement in data.aws_iam_policy_document.release_retirement.statement :
      statement.resources == toset(["arn:aws:s3:::spawnpoint-releases-123456789012/presets/*/catalog.json"])
      if length([for action in statement.actions : action if startswith(action, "s3:Put")]) > 0
    ])
    error_message = "The only s3:Put* is on presets/*/catalog.json."
  }

  assert {
    condition = alltrue([
      length([for statement in data.aws_iam_policy_document.release_retirement.statement : statement if length([for action in statement.actions : action if startswith(action, "s3:Put")]) > 0]) == 1,
      one([for statement in data.aws_iam_policy_document.release_retirement.statement : statement.actions if statement.sid == "WritePresetCatalog"]) == toset(["s3:PutObject"]),
    ])
    error_message = "One statement writes to S3, and it writes the catalog only."
  }

  # No write on any other table, and none outside the reference table.
  assert {
    condition = alltrue([
      for statement in data.aws_iam_policy_document.release_retirement.statement :
      statement.resources == toset(["arn:aws:dynamodb:eu-central-1:123456789012:table/spawnpoint-release-refs"])
      if length([for action in statement.actions : action if startswith(action, "dynamodb:")]) > 0
    ])
    error_message = "Retirement reaches the reference table only: no other table, no index."
  }

  assert {
    condition = alltrue([
      one([for statement in data.aws_iam_policy_document.release_retirement.statement : statement.resources if statement.sid == "ReadReleaseSources"]) == toset([
        "arn:aws:s3:::spawnpoint-releases-123456789012/releases/*",
        "arn:aws:s3:::spawnpoint-releases-123456789012/worlds/*",
        "arn:aws:s3:::spawnpoint-releases-123456789012/presets/*",
      ]),
      one([for statement in data.aws_iam_policy_document.release_retirement.statement : statement.resources if statement.sid == "ReadArchiveMetadata"]) == toset(["arn:aws:s3:::spawnpoint-backups-123456789012/worlds/*/archives/*"]),
    ])
    error_message = "Retirement reads release, world and preset keys and archive metadata. It never reads objects/."
  }

  assert {
    condition = alltrue([
      aws_cloudwatch_metric_alarm.release_retirement_errors.metric_name == "Errors",
      aws_cloudwatch_metric_alarm.release_retirement_errors.dimensions.FunctionName == "spawnpoint-release-retirement",
      contains(aws_cloudwatch_metric_alarm.release_retirement_errors.alarm_actions, "arn:aws:sns:eu-central-1:123456789012:spawnpoint-alert"),
    ])
    error_message = "A failed retirement must alarm the guardrails topic."
  }
}
