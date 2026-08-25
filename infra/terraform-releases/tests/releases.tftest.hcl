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
    target = data.aws_iam_policy_document.step_functions_assume_role
    values = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}"
    }
  }

  override_data {
    target = data.aws_iam_policy_document.codebuild_assume_role
    values = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}"
    }
  }

  override_data {
    target = data.aws_iam_policy_document.release_builder
    values = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}"
    }
  }

  override_data {
    target = data.aws_iam_policy_document.build_release_workflow
    values = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}"
    }
  }
}

run "release_builder_is_inert_pinned_and_credential_scoped" {
  command = plan

  assert {
    condition     = aws_codebuild_project.release_builder.source[0].type == "S3" && aws_codebuild_project.release_builder.artifacts[0].type == "NO_ARTIFACTS"
    error_message = "The builder must execute reviewed S3 source and publish directly, not accept caller-controlled source."
  }

  assert {
    condition     = aws_codebuild_project.release_builder.environment[0].compute_type == "BUILD_GENERAL1_SMALL" && aws_codebuild_project.release_builder.concurrent_build_limit == 1
    error_message = "Release resolution is a small single-flight batch job."
  }

  assert {
    condition     = aws_codebuild_project.release_builder.environment[0].privileged_mode
    error_message = "The digest-pinned resolver image requires Docker inside CodeBuild."
  }

  assert {
    condition = anytrue([
      for variable in aws_codebuild_project.release_builder.environment[0].environment_variable :
      variable.name == "CF_API_KEY" && variable.type == "PARAMETER_STORE" && variable.value == "/spawnpoint/releases/curseforge-api-key"
    ])
    error_message = "The CurseForge key must be injected from Parameter Store and never enter Terraform state as a value."
  }

  assert {
    condition     = can(regex("^control-plane/release-builder/[0-9a-f]{64}\\.zip$", aws_s3_object.release_builder_source.key))
    error_message = "The reviewed builder source must be content-addressed and outside the release namespace."
  }

  assert {
    condition     = aws_cloudwatch_log_group.release_builder.retention_in_days == 14
    error_message = "Release build logs must have bounded retention."
  }
}

run "build_release_workflow_can_only_run_the_reviewed_builder" {
  command = plan

  assert {
    condition     = aws_sfn_state_machine.build_release.type == "STANDARD"
    error_message = "Release resolution can take minutes and must use a durable Standard workflow."
  }

  assert {
    condition     = jsondecode(aws_sfn_state_machine.build_release.definition).States["Build Immutable Release"].Resource == "arn:aws:states:::codebuild:startBuild.sync"
    error_message = "The workflow must wait for CodeBuild directly rather than orchestrating a long Lambda."
  }

  assert {
    condition     = jsondecode(aws_sfn_state_machine.build_release.definition).States["Build Immutable Release"].Parameters.ProjectName == aws_codebuild_project.release_builder.name
    error_message = "Callers must not choose which CodeBuild project receives the release-builder role."
  }

  assert {
    condition = toset([
      for variable in jsondecode(aws_sfn_state_machine.build_release.definition).States["Build Immutable Release"].Parameters.EnvironmentVariablesOverride :
      variable.Name
    ]) == toset(["PROFILE_ID", "CONFIG_COMMIT", "RELEASE", "RELEASE_CREATED_BY"])
    error_message = "The workflow may override only release identity, never secrets, buckets, source or buildspec."
  }

  assert {
    condition     = jsondecode(aws_sfn_state_machine.build_release.definition).States["Release Ready"].Parameters.status == "READY"
    error_message = "Only a synchronously successful build may produce READY."
  }
}
