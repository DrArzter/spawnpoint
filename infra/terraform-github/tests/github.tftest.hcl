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

  assert {
    condition = anytrue([
      for statement in data.aws_iam_policy_document.github_plan_iam.statement :
      contains(statement.actions, "route53:Get*") && contains(statement.actions, "route53:List*")
    ])
    error_message = "The plan identity must be able to refresh public DNS without changing it."
  }

  assert {
    condition = anytrue([
      for statement in data.aws_iam_policy_document.github_plan_iam.statement :
      contains(statement.actions, "acm:DescribeCertificate") && contains(statement.actions, "acm:ListTagsForCertificate")
    ])
    error_message = "The plan identity must be able to refresh the CloudFront certificate without changing it."
  }

  assert {
    condition = alltrue([
      for statement in data.aws_iam_policy_document.github_plan_iam.statement :
      !contains(statement.actions, "s3:GetObject") ||
      alltrue([for resource in statement.resources : can(regex("^arn:aws:s3:::spawnpoint-(tfstate-[0-9]+(/spawnpoint/\\*)?|releases-[0-9]+/control-plane/\\*)$", resource))])
    ])
    error_message = "The plan identity may read objects only from the Terraform state prefix and the Terraform-managed control-plane bundles, never a release, world or preset payload."
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
    condition     = anytrue([for statement in data.aws_iam_policy_document.github_deploy_iam.statement : contains(statement.actions, "dynamodb:UpdateTimeToLive")])
    error_message = "The deploy identity must be able to enable expiry cleanup for login-session records."
  }

  assert {
    condition = anytrue([
      for statement in data.aws_iam_policy_document.github_deploy_iam.statement :
      alltrue([
        contains(statement.actions, "ec2:CreateLaunchTemplate"),
        contains(statement.actions, "ec2:CreateLaunchTemplateVersion"),
        contains(statement.actions, "ec2:ModifyLaunchTemplate"),
      ])
    ])
    error_message = "The deploy identity must be able to create and revise the fleet host launch template."
  }

  assert {
    condition = anytrue([
      for statement in data.aws_iam_policy_document.github_deploy_iam.statement :
      statement.sid == "TagOnlyApiGatewayApisAndStages" &&
      toset(statement.actions) == toset(["apigateway:TagResource", "apigateway:UntagResource"]) &&
      alltrue([
        for resource in statement.resources :
        can(regex("^arn:aws:apigateway:[^:]+::/apis/\\*(/stages(/\\*)?)?$", resource))
      ])
    ])
    error_message = "The deploy identity must manage API Gateway tags only on APIs and their stages."
  }

  assert {
    condition = anytrue([
      for statement in data.aws_iam_policy_document.github_deploy_iam.statement :
      statement.sid == "DestroyOnlyAllowListedWiring" && !contains(statement.resources, "*")
    ])
    error_message = "The pipeline may destroy only allow-listable wiring, and only on spawnpoint-scoped resources."
  }

  assert {
    condition = alltrue([
      for statement in data.aws_iam_policy_document.github_deploy_iam.statement :
      coalesce(statement.effect, "Allow") != "Allow" || length(setintersection(toset(statement.actions), toset([
        "ec2:TerminateInstances", "ec2:DeleteVolume", "s3:DeleteBucket", "dynamodb:DeleteTable",
        "iam:DeleteOpenIDConnectProvider", "cloudfront:DeleteDistribution", "lambda:DeleteFunction",
        "lambda:DeleteFunctionUrlConfig", "budgets:DeleteBudget", "sns:DeleteTopic",
      ]))) == 0
    ])
    error_message = "The host, its volume, the buckets, the tables, the OIDC trust, the distribution, the bot URL and the guardrails stay undeletable by the pipeline."
  }

  assert {
    condition = alltrue([
      for statement in data.aws_iam_policy_document.github_deploy_iam.statement :
      !contains(statement.actions, "route53:DeleteHostedZone")
    ])
    error_message = "The production pipeline must never delete the authoritative public DNS zone."
  }

  assert {
    condition = (
      anytrue([
        for statement in data.aws_iam_policy_document.github_deploy_iam.statement :
        contains(statement.actions, "acm:RequestCertificate") && contains(statement.actions, "acm:AddTagsToCertificate")
      ]) &&
      alltrue([
        for statement in data.aws_iam_policy_document.github_deploy_iam.statement :
        !contains(statement.actions, "acm:DeleteCertificate")
      ])
    )
    error_message = "The deploy identity may issue the panel certificate but must not delete certificates."
  }

  assert {
    condition = anytrue([
      for statement in data.aws_iam_policy_document.github_deploy_iam.statement :
      contains(statement.actions, "cloudfront:CreateResponseHeadersPolicy") && contains(statement.actions, "cloudfront:UpdateResponseHeadersPolicy")
    ])
    error_message = "The deploy identity must manage the panel's popup-compatible response headers policy."
  }

  assert {
    condition = anytrue([
      for statement in data.aws_iam_policy_document.github_deploy_iam.statement :
      statement.sid == "TagOnlyReleaseBuilderSources" &&
      toset(statement.actions) == toset(["s3:PutObjectTagging"]) &&
      toset(statement.resources) == toset([
        "arn:aws:s3:::spawnpoint-releases-${data.aws_caller_identity.current.account_id}/control-plane/release-builder/*",
      ])
    ])
    error_message = "The deploy identity may tag only release-builder source objects in the releases bucket."
  }

  assert {
    condition = anytrue([
      for statement in data.aws_iam_policy_document.github_deploy_iam.statement :
      coalesce(statement.effect, "Allow") == "Deny" && contains(statement.actions, "iam:DeleteRole") &&
      alltrue([for resource in statement.resources : endswith(resource, ":role/spawnpoint-github-*")])
    ])
    error_message = "The deploy identity must never be able to delete the GitHub identities, its own included."
  }

  assert {
    condition = anytrue([
      for statement in data.aws_iam_policy_document.github_deploy_iam.statement :
      coalesce(statement.effect, "Allow") == "Deny" && contains(statement.actions, "iam:*") &&
      alltrue([for resource in statement.resources : endswith(resource, ":role/spawnpoint-github-identity-admin")])
    ])
    error_message = "The deploy identity must never reach the identity anchor that applies this root; that is the loop the anchor closes."
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
