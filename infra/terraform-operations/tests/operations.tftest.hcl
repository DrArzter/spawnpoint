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
}

run "idle_watchdog_probes_host_and_runs_verified_stop" {
  command = plan

  assert {
    condition     = aws_sfn_state_machine.idle_watchdog.type == "STANDARD"
    error_message = "The watchdog waits for hours; only a Standard workflow makes those waits free."
  }

  assert {
    condition     = jsondecode(aws_sfn_state_machine.idle_watchdog.definition).States["Send Probe"].Parameters.Parameters.commands[1] == "/srv/spawnpoint/app/server/scripts/idle-probe.sh"
    error_message = "The watchdog must probe through the host's exit-code contract, never parse RCON itself."
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
    condition     = strcontains(aws_sfn_state_machine.promote_release.definition, "States.JsonToString($.document)")
    error_message = "Pointer documents must be built as objects and serialised, never hand-formatted strings."
  }
}
