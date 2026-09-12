mock_provider "aws" {
  override_during = plan

  override_data {
    target = data.aws_caller_identity.current
    values = {
      account_id = "123456789012"
    }
  }

  override_data {
    target = data.aws_iam_policy_document.github_actions_assume_role
    values = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}"
    }
  }

  override_data {
    target = data.aws_iam_policy_document.github_release
    values = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}"
    }
  }

  override_data {
    target = data.aws_iam_policy_document.github_deploy_assume_role
    values = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}"
    }
  }

  override_data {
    target = data.aws_iam_policy_document.github_deploy_iam
    values = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}"
    }
  }

  override_data {
    target = data.aws_iam_policy_document.github_plan_assume_role
    values = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}"
    }
  }

  override_data {
    target = data.aws_iam_policy_document.github_plan_iam
    values = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}"
    }
  }
}

run "plan_role_is_owner_reviewed_and_separate_from_deploy" {
  command = plan

  assert {
    condition     = local.plan_subject == "repo:DrArzter@102290466/spawnpoint@1330947749:environment:production-plan"
    error_message = "Pull request plans must use the immutable Spawnpoint repository identity and the production-plan environment."
  }

  assert {
    condition     = aws_iam_role.github_plan.name != aws_iam_role.github_deploy.name
    error_message = "Pull request plans and production deployment must never share an IAM role."
  }

  assert {
    condition     = anytrue([for statement in data.aws_iam_policy_document.github_plan_iam.statement : contains(statement.actions, "states:ValidateStateMachineDefinition")])
    error_message = "The provider validates a state-machine definition during plan; without this action every pull request that touches a workflow fails its required check."
  }
}

run "deployment_role_trusts_only_the_production_environment" {
  command = plan

  assert {
    condition     = local.deploy_subject == "repo:DrArzter@102290466/spawnpoint@1330947749:environment:production"
    error_message = "Production deploys must use the immutable Spawnpoint repository and owner ids plus the production environment."
  }

  assert {
    condition     = anytrue([for statement in data.aws_iam_policy_document.github_deploy_iam.statement : contains(statement.actions, "states:ValidateStateMachineDefinition")])
    error_message = "An apply plans first; the deploy identity needs the same validation action as the plan identity."
  }

  assert {
    condition     = aws_iam_role.github_deploy.max_session_duration == 3600
    error_message = "The production deployment role does not need a session longer than one hour."
  }

}

run "trusts_only_the_config_repositories_main_branches" {
  command = plan

  assert {
    condition = local.github_subjects == toset([
      "repo:DrArzter/my-docker-minecraft-server-config:ref:refs/heads/main",
      "repo:DrArzter@102290466/my-docker-factorio-server-config@1348549387:ref:refs/heads/main",
      "repo:DrArzter@102290466/my-docker-zomboid-server-config@1352117153:ref:refs/heads/main",
    ])
    error_message = "The role trust must name each config repository's main branch exactly."
  }

  assert {
    condition = (
      aws_iam_openid_connect_provider.github_actions.url == "https://token.actions.githubusercontent.com" &&
      toset(aws_iam_openid_connect_provider.github_actions.client_id_list) == toset(["sts.amazonaws.com"])
    )
    error_message = "GitHub Actions must use AWS STS as the sole OIDC audience."
  }

  assert {
    condition     = aws_iam_role.github_release.max_session_duration == 3600
    error_message = "A release trigger does not need a long-lived cloud session."
  }
}

run "role_can_only_start_and_observe_the_release_builder" {
  command = plan

  assert {
    condition     = local.build_release_state_machine_arn == "arn:aws:states:eu-central-1:123456789012:stateMachine:spawnpoint-build-release"
    error_message = "StartExecution must target only the fixed release-build state machine."
  }

  assert {
    condition     = local.preset_catalog_state_machine_arn == "arn:aws:states:eu-central-1:123456789012:stateMachine:spawnpoint-publish-preset-catalog"
    error_message = "Catalog publication must target only its fixed state machine."
  }

  assert {
    condition     = local.build_release_execution_arn == "arn:aws:states:eu-central-1:123456789012:execution:spawnpoint-build-release:*"
    error_message = "DescribeExecution must target only executions belonging to the release builder."
  }

  assert {
    condition     = local.preset_catalog_objects_arn == "arn:aws:s3:::spawnpoint-releases-123456789012/presets/*/catalog.json"
    error_message = "Automatic builds may read only published preset catalogs, never release payloads or world state."
  }
}
