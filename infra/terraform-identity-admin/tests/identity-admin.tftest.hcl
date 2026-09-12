mock_provider "aws" {
  override_during = plan

  override_data {
    target = data.aws_caller_identity.current
    values = {
      account_id = "123456789012"
    }
  }

  override_data {
    target = data.aws_iam_policy_document.identity_admin_assume_role
    values = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}"
    }
  }

  override_data {
    target = data.aws_iam_policy_document.identity_admin
    values = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}"
    }
  }
}

run "trusts_only_the_owner_approved_identity_environment" {
  command = plan

  assert {
    condition     = local.identity_subject == "repo:DrArzter@102290466/spawnpoint@1330947749:environment:production-identity"
    error_message = "The identity job must run under the immutable Spawnpoint repository identity and the production-identity environment."
  }

  assert {
    condition     = aws_iam_role.github_identity_admin.name == "spawnpoint-github-identity-admin"
    error_message = "The deploy identity's denies name this role; renaming it would open the loop they close."
  }

  assert {
    condition     = aws_iam_role.github_identity_admin.max_session_duration == 3600
    error_message = "Applying one small root does not need a session longer than one hour."
  }
}

run "changes_only_the_github_identities_and_never_deletes_or_touches_itself" {
  command = plan

  assert {
    condition = alltrue([
      for statement in data.aws_iam_policy_document.identity_admin.statement :
      coalesce(statement.effect, "Allow") != "Allow" || length([for action in statement.actions : action if can(regex("^iam:Delete", action))]) == 0
    ])
    error_message = "Retiring an identity is a hand apply; the identity job may create and update, never delete."
  }

  assert {
    condition = alltrue([
      for statement in data.aws_iam_policy_document.identity_admin.statement :
      coalesce(statement.effect, "Allow") != "Allow" ||
      length([for action in statement.actions : action if startswith(action, "iam:")]) == 0 ||
      alltrue([for resource in statement.resources : can(regex(":role/spawnpoint-github-\\*$|:oidc-provider/token\\.actions\\.githubusercontent\\.com$", resource))])
    ])
    error_message = "Every IAM permission must be scoped to the spawnpoint-github-* roles or the GitHub OIDC provider."
  }

  assert {
    condition = anytrue([
      for statement in data.aws_iam_policy_document.identity_admin.statement :
      coalesce(statement.effect, "Allow") == "Deny" && contains(statement.actions, "iam:*") &&
      alltrue([for resource in statement.resources : endswith(resource, ":role/spawnpoint-github-identity-admin")])
    ])
    error_message = "The identity job must be unable to change its own trust or permissions."
  }

  assert {
    condition = alltrue([
      for statement in data.aws_iam_policy_document.identity_admin.statement :
      length([for action in statement.actions : action if can(regex("^s3:(Get|Put|Delete)Object", action))]) == 0 ||
      alltrue([for resource in statement.resources : can(regex("/spawnpoint/github-oidc\\.tfstate(\\.tflock)?$", resource))])
    ])
    error_message = "The identity job may read and write only the GitHub identities' own state object and its lock."
  }
}
