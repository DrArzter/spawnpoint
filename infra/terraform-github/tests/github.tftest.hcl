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
}

run "trusts_only_the_config_repository_main_branch" {
  command = plan

  assert {
    condition     = local.github_subject == "repo:DrArzter/my-docker-minecraft-server-config:ref:refs/heads/main"
    error_message = "The role trust must be exact, not repository-wide or organization-wide."
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
    condition     = local.build_release_execution_arn == "arn:aws:states:eu-central-1:123456789012:execution:spawnpoint-build-release:*"
    error_message = "DescribeExecution must target only executions belonging to the release builder."
  }
}
