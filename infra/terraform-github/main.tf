data "aws_caller_identity" "current" {}

locals {
  github_subjects = var.github_subjects

  build_release_state_machine_arn  = "arn:aws:states:${var.aws_region}:${data.aws_caller_identity.current.account_id}:stateMachine:spawnpoint-build-release"
  build_release_execution_arn      = "arn:aws:states:${var.aws_region}:${data.aws_caller_identity.current.account_id}:execution:spawnpoint-build-release:*"
  preset_catalog_state_machine_arn = "arn:aws:states:${var.aws_region}:${data.aws_caller_identity.current.account_id}:stateMachine:spawnpoint-publish-preset-catalog"
  preset_catalog_execution_arn     = "arn:aws:states:${var.aws_region}:${data.aws_caller_identity.current.account_id}:execution:spawnpoint-publish-preset-catalog:*"
  config_source_objects_arn        = "arn:aws:s3:::spawnpoint-releases-${data.aws_caller_identity.current.account_id}/config-sources/*"
  preset_catalog_objects_arn       = "arn:aws:s3:::spawnpoint-releases-${data.aws_caller_identity.current.account_id}/presets/*/catalog.json"
}

# AWS validates GitHub's certificate against its trusted root CA library, so
# this provider deliberately has no brittle, manually maintained thumbprint.
resource "aws_iam_openid_connect_provider" "github_actions" {
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]

  tags = {
    Name    = "github-actions"
    Purpose = "release-build-identity"
  }
}

data "aws_iam_policy_document" "github_actions_assume_role" {
  statement {
    sid     = "OnlyConfigRepositoryMain"
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github_actions.arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = local.github_subjects
    }
  }
}

resource "aws_iam_role" "github_release" {
  name                 = "spawnpoint-github-release"
  description          = "Lets the config repository request and observe one release-build workflow."
  assume_role_policy   = data.aws_iam_policy_document.github_actions_assume_role.json
  max_session_duration = 3600

  tags = {
    Name    = "spawnpoint-github-release"
    Purpose = "release-build-trigger"
  }
}

data "aws_iam_policy_document" "github_release" {
  statement {
    sid       = "StartOnlyReleaseBuilder"
    effect    = "Allow"
    actions   = ["states:StartExecution"]
    resources = [local.build_release_state_machine_arn, local.preset_catalog_state_machine_arn]
  }

  statement {
    sid       = "ObserveOnlyReleaseBuilderExecutions"
    effect    = "Allow"
    actions   = ["states:DescribeExecution"]
    resources = [local.build_release_execution_arn, local.preset_catalog_execution_arn]
  }

  statement {
    sid       = "StageGitConfigSnapshots"
    effect    = "Allow"
    actions   = ["s3:GetObject", "s3:PutObject"]
    resources = [local.config_source_objects_arn]
  }

  statement {
    sid       = "ReadPublishedPresetCatalogs"
    effect    = "Allow"
    actions   = ["s3:GetObject"]
    resources = [local.preset_catalog_objects_arn]
  }
}

resource "aws_iam_role_policy" "github_release" {
  name   = "spawnpoint-github-release"
  role   = aws_iam_role.github_release.id
  policy = data.aws_iam_policy_document.github_release.json
}
