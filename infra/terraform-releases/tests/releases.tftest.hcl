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
    condition     = aws_codebuild_project.release_builder.environment[0].compute_type == "BUILD_GENERAL1_SMALL" && aws_codebuild_project.release_builder.concurrent_build_limit == 3
    error_message = "Release resolution stays small while allowing one independent build per supported game."
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
    condition = length([
      for variable in aws_codebuild_project.release_builder.environment[0].environment_variable :
      variable if variable.name == "CONFIG_REPOSITORY_URL" && variable.value == "REQUIRED_BY_CALLER"
    ]) == 1
    error_message = "One authoring repository per game, so the project must not default to either one."
  }

  assert {
    condition = length([
      for variable in aws_codebuild_project.release_builder.environment[0].environment_variable :
      variable if variable.name == "CONFIG_SOURCE_KIND" && variable.value == "github-snapshot"
    ]) == 1
    error_message = "The release builder must select the reviewed GitHub snapshot source adapter explicitly."
  }

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
    ]) == toset(["PROFILE_ID", "CONFIG_COMMIT", "CONFIG_SOURCE_KEY", "CONFIG_SOURCE_SHA256", "RELEASE", "CONFIG_REPOSITORY_URL", "RELEASE_CREATED_BY"])
    error_message = "The workflow may override only release and staged Git source identity, never secrets, buckets or buildspec."
  }

  assert {
    condition     = jsondecode(aws_sfn_state_machine.build_release.definition).States["Release Ready"].Parameters.status == "READY"
    error_message = "Only a synchronously successful build may produce READY."
  }
}

run "release_builder_writes_objects_without_deleting" {
  command = plan

  assert {
    condition = alltrue([
      one([for statement in data.aws_iam_policy_document.release_builder.statement : statement.actions if statement.sid == "WriteContentAddressedObjects"]) == toset(["s3:GetObject", "s3:PutObject"]),
      one([for statement in data.aws_iam_policy_document.release_builder.statement : statement.resources if statement.sid == "WriteContentAddressedObjects"]) == toset(["arn:aws:s3:::spawnpoint-releases-123456789012/objects/*"]),
    ])
    error_message = "The release builder reads and writes content-addressed objects under objects/ only, and never deletes them."
  }
}

run "release_builder_caches_upstream_files_only_under_upstream" {
  command = plan

  assert {
    condition = alltrue([
      one([for statement in data.aws_iam_policy_document.release_builder.statement : statement.actions if statement.sid == "CacheUpstreamFiles"]) == toset(["s3:GetObject", "s3:PutObject"]),
      one([for statement in data.aws_iam_policy_document.release_builder.statement : statement.resources if statement.sid == "CacheUpstreamFiles"]) == toset(["arn:aws:s3:::spawnpoint-releases-123456789012/upstream/*"]),
    ])
    error_message = "The release builder reads and writes the upstream cache under upstream/ only."
  }

  assert {
    condition = alltrue(flatten([
      for statement in data.aws_iam_policy_document.release_builder.statement : [
        for action in statement.actions : !can(regex("^s3:Delete", action))
      ]
    ]))
    error_message = "The release builder may not delete objects."
  }

  assert {
    condition = alltrue(flatten([
      for statement in data.aws_iam_policy_document.release_builder.statement : [
        for action in statement.actions : statement.sid == "ListPublishedReleases" || !can(regex("^s3:List", action))
      ]
    ]))
    error_message = "The release builder may list objects only to find the published releases."
  }

  assert {
    condition = alltrue([
      one([for statement in data.aws_iam_policy_document.release_builder.statement : statement.actions if statement.sid == "ListPublishedReleases"]) == toset(["s3:ListBucket"]),
      one(flatten([for statement in data.aws_iam_policy_document.release_builder.statement : [for condition in statement.condition : condition.values if statement.sid == "ListPublishedReleases"]])) == "releases/*",
    ])
    error_message = "The listing is limited to the release prefix."
  }
}

run "storage_layout_defaults_to_legacy" {
  command = plan

  assert {
    condition     = var.release_storage_layout == "legacy"
    error_message = "The builder writes the legacy layout until the readers are deployed."
  }

  assert {
    condition = one([
      for variable in aws_codebuild_project.release_builder.environment[0].environment_variable :
      variable.value if variable.name == "RELEASE_STORAGE_LAYOUT"
    ]) == "legacy"
    error_message = "The CodeBuild project passes the layout flag, off by default."
  }

  assert {
    condition = one([
      for variable in aws_codebuild_project.release_builder.environment[0].environment_variable :
      variable.value if variable.name == "RELEASE_REFS_TABLE"
    ]) == "spawnpoint-release-refs"
    error_message = "The builder names the reference table that the storage root creates."
  }
}

run "objects_v1_layout_is_accepted" {
  command = plan

  variables {
    release_storage_layout = "objects-v1"
  }

  assert {
    condition = one([
      for variable in aws_codebuild_project.release_builder.environment[0].environment_variable :
      variable.value if variable.name == "RELEASE_STORAGE_LAYOUT"
    ]) == "objects-v1"
    error_message = "The flag reaches the build."
  }
}

run "an_unknown_storage_layout_is_refused" {
  command = plan

  variables {
    release_storage_layout = "objects-v2"
  }

  expect_failures = [var.release_storage_layout]
}

run "release_builder_updates_only_the_reference_table" {
  command = plan

  assert {
    condition = alltrue([
      one([for statement in data.aws_iam_policy_document.release_builder.statement : statement.actions if statement.sid == "UpdateReleaseReferences"]) == toset(["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem"]),
      one([for statement in data.aws_iam_policy_document.release_builder.statement : statement.resources if statement.sid == "UpdateReleaseReferences"]) == toset(["arn:aws:dynamodb:eu-central-1:123456789012:table/spawnpoint-release-refs"]),
    ])
    error_message = "The builder gets exactly GetItem, PutItem, UpdateItem and DeleteItem on the reference table."
  }

  assert {
    condition = alltrue(flatten([
      for statement in data.aws_iam_policy_document.release_builder.statement : [
        for action in statement.actions : statement.sid == "UpdateReleaseReferences" || !can(regex("^dynamodb:", action))
      ]
    ]))
    error_message = "No other statement may reach DynamoDB: no scan, no query, no other table."
  }

  assert {
    condition = alltrue(flatten([
      for statement in data.aws_iam_policy_document.release_builder.statement : [
        for action in statement.actions : !can(regex("^s3:Delete", action))
      ]
    ]))
    error_message = "The release builder may not delete objects."
  }
}
