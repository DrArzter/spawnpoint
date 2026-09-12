data "aws_caller_identity" "current" {}

locals {
  github_subjects = var.github_subjects
  deploy_subject  = "repo:DrArzter@102290466/spawnpoint@1330947749:environment:production"

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

data "aws_iam_policy_document" "github_deploy_assume_role" {
  statement {
    sid     = "OnlySpawnpointProductionEnvironment"
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
      values   = [local.deploy_subject]
    }
  }
}

resource "aws_iam_role" "github_deploy" {
  name                 = "spawnpoint-github-deploy"
  description          = "Deploys tested Spawnpoint production units from the protected GitHub environment."
  assume_role_policy   = data.aws_iam_policy_document.github_deploy_assume_role.json
  max_session_duration = 3600

  tags = {
    Name    = "spawnpoint-github-deploy"
    Purpose = "production-deployment"
  }
}

data "aws_iam_policy_document" "github_deploy_iam" {
  statement {
    sid    = "ReadProductionState"
    effect = "Allow"
    actions = [
      "s3:GetObject",
      "s3:ListBucket",
      "s3:PutObject",
    ]
    resources = [
      "arn:aws:s3:::spawnpoint-tfstate-${data.aws_caller_identity.current.account_id}",
      "arn:aws:s3:::spawnpoint-tfstate-${data.aws_caller_identity.current.account_id}/spawnpoint/*",
    ]
  }

  statement {
    sid     = "ReleaseProductionStateLocks"
    effect  = "Allow"
    actions = ["s3:DeleteObject"]
    resources = [
      "arn:aws:s3:::spawnpoint-tfstate-${data.aws_caller_identity.current.account_id}/spawnpoint/*.tflock",
    ]
  }

  statement {
    sid    = "ReadExistingInfrastructure"
    effect = "Allow"
    actions = [
      "apigateway:GET",
      "budgets:Describe*",
      "ce:Get*",
      "ce:List*",
      "cloudfront:Get*",
      "cloudfront:List*",
      "cloudwatch:Describe*",
      "cloudwatch:List*",
      "codebuild:BatchGet*",
      "codebuild:List*",
      "dynamodb:Describe*",
      "dynamodb:List*",
      "ec2:Describe*",
      "events:Describe*",
      "events:List*",
      "iam:Get*",
      "iam:List*",
      "lambda:Get*",
      "lambda:List*",
      "logs:Describe*",
      "logs:List*",
      "s3:Get*",
      "s3:List*",
      "sns:Get*",
      "sns:List*",
      "ssm:Describe*",
      "ssm:GetParameter",
      "states:Describe*",
      "states:List*",
      "sts:GetCallerIdentity",
    ]
    resources = ["*"]
  }

  statement {
    sid    = "CreateOrUpdateSpawnpointInfrastructure"
    effect = "Allow"
    actions = [
      "apigateway:PATCH",
      "apigateway:POST",
      "apigateway:PUT",
      "budgets:ModifyBudget",
      "ce:CreateAnomalyMonitor",
      "ce:CreateAnomalySubscription",
      "ce:UpdateAnomalyMonitor",
      "ce:UpdateAnomalySubscription",
      "cloudfront:CreateDistribution",
      "cloudfront:CreateOriginAccessControl",
      "cloudfront:TagResource",
      "cloudfront:UpdateDistribution",
      "cloudfront:UpdateOriginAccessControl",
      "cloudwatch:PutMetricAlarm",
      "cloudwatch:TagResource",
      "codebuild:CreateProject",
      "codebuild:UpdateProject",
      "dynamodb:CreateTable",
      "dynamodb:TagResource",
      "dynamodb:UpdateContinuousBackups",
      "dynamodb:UpdateTable",
      "ec2:AssociateRouteTable",
      "ec2:AttachVolume",
      "ec2:CreateInternetGateway",
      "ec2:CreateRoute",
      "ec2:CreateRouteTable",
      "ec2:CreateSecurityGroup",
      "ec2:CreateSubnet",
      "ec2:CreateTags",
      "ec2:CreateVolume",
      "ec2:CreateVpc",
      "ec2:ModifyInstanceAttribute",
      "ec2:ModifySubnetAttribute",
      "ec2:ModifyVolume",
      "ec2:ModifyVpcAttribute",
      "ec2:RunInstances",
      "events:PutRule",
      "events:PutTargets",
      "events:TagResource",
      "lambda:AddPermission",
      "lambda:CreateFunction",
      "lambda:CreateFunctionUrlConfig",
      "lambda:TagResource",
      "lambda:UpdateFunctionCode",
      "lambda:UpdateFunctionConfiguration",
      "lambda:UpdateFunctionUrlConfig",
      "logs:CreateLogGroup",
      "logs:PutRetentionPolicy",
      "logs:TagResource",
      "s3:CreateBucket",
      "s3:PutLifecycleConfiguration",
      "s3:PutBucketOwnershipControls",
      "s3:PutBucketPolicy",
      "s3:PutBucketPublicAccessBlock",
      "s3:PutBucketTagging",
      "s3:PutBucketVersioning",
      "s3:PutEncryptionConfiguration",
      "s3:PutObject",
      "sns:CreateTopic",
      "sns:SetTopicAttributes",
      "sns:Subscribe",
      "sns:TagResource",
      "states:CreateStateMachine",
      "states:TagResource",
      "states:UpdateStateMachine",
    ]
    resources = ["*"]
  }

  statement {
    sid    = "ManageOnlySpawnpointIdentities"
    effect = "Allow"
    actions = [
      "iam:AddRoleToInstanceProfile",
      "iam:CreateInstanceProfile",
      "iam:CreateRole",
      "iam:PassRole",
      "iam:PutRolePolicy",
      "iam:TagInstanceProfile",
      "iam:TagRole",
      "iam:UntagInstanceProfile",
      "iam:UntagRole",
      "iam:UpdateAssumeRolePolicy",
      "iam:UpdateRole",
    ]
    resources = [
      "arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/spawnpoint-*",
      "arn:aws:iam::${data.aws_caller_identity.current.account_id}:instance-profile/spawnpoint-*",
    ]
  }

  statement {
    sid       = "AttachOnlyLambdaLoggingPolicy"
    effect    = "Allow"
    actions   = ["iam:AttachRolePolicy"]
    resources = ["arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/spawnpoint-*"]

    condition {
      test     = "ArnEquals"
      variable = "iam:PolicyARN"
      values   = ["arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"]
    }
  }

  statement {
    sid     = "PublishAndPruneOnlyTheWebApplication"
    effect  = "Allow"
    actions = ["s3:DeleteObject", "s3:PutObject"]
    resources = [
      "arn:aws:s3:::spawnpoint-web-${data.aws_caller_identity.current.account_id}/assets/*",
      "arn:aws:s3:::spawnpoint-web-${data.aws_caller_identity.current.account_id}/index.html",
    ]
  }

  statement {
    sid       = "NeverMutateOwnDeploymentIdentity"
    effect    = "Deny"
    actions   = ["iam:*"]
    resources = ["arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/spawnpoint-github-deploy"]
  }
}

resource "aws_iam_role_policy" "github_deploy_iam" {
  name   = "spawnpoint-github-deploy-iam"
  role   = aws_iam_role.github_deploy.id
  policy = data.aws_iam_policy_document.github_deploy_iam.json
}
