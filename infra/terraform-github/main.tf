data "aws_caller_identity" "current" {}

locals {
  github_subjects = var.github_subjects
  deploy_subject  = "repo:DrArzter@102290466/spawnpoint@1330947749:environment:production"
  plan_subject    = "repo:DrArzter@102290466/spawnpoint@1330947749:environment:production-plan"

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
      "acm:DescribeCertificate",
      "acm:ListCertificates",
      "acm:ListTagsForCertificate",
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
      "route53:Get*",
      "route53:List*",
      "s3:Get*",
      "s3:List*",
      "sns:Get*",
      "sns:List*",
      "ssm:Describe*",
      "ssm:GetParameter",
      "states:Describe*",
      "states:List*",
      "states:ValidateStateMachineDefinition",
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
      "acm:AddTagsToCertificate",
      "acm:RequestCertificate",
      "budgets:ModifyBudget",
      "ce:CreateAnomalyMonitor",
      "ce:CreateAnomalySubscription",
      "ce:UpdateAnomalyMonitor",
      "ce:UpdateAnomalySubscription",
      "cloudfront:CreateDistribution",
      "cloudfront:CreateOriginAccessControl",
      "cloudfront:CreateResponseHeadersPolicy",
      "cloudfront:TagResource",
      "cloudfront:UpdateDistribution",
      "cloudfront:UpdateOriginAccessControl",
      "cloudfront:UpdateResponseHeadersPolicy",
      "cloudwatch:PutMetricAlarm",
      "cloudwatch:TagResource",
      "codebuild:CreateProject",
      "codebuild:UpdateProject",
      "dynamodb:CreateTable",
      "dynamodb:TagResource",
      "dynamodb:UpdateContinuousBackups",
      "dynamodb:UpdateTable",
      "dynamodb:UpdateTimeToLive",
      "ec2:AssociateRouteTable",
      "ec2:AttachVolume",
      "ec2:CreateInternetGateway",
      "ec2:CreateLaunchTemplate",
      "ec2:CreateLaunchTemplateVersion",
      "ec2:CreateRoute",
      "ec2:CreateRouteTable",
      "ec2:CreateSecurityGroup",
      "ec2:CreateSubnet",
      "ec2:CreateTags",
      "ec2:CreateVolume",
      "ec2:CreateVpc",
      "ec2:ModifyInstanceAttribute",
      "ec2:ModifyLaunchTemplate",
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
      "route53:ChangeResourceRecordSets",
      "route53:ChangeTagsForResource",
      "route53:CreateHostedZone",
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

  # API Gateway evaluates tags supplied while a stage is created as a
  # separate TagResource call against the API's stage collection. Keep that
  # permission out of the broad create/update statement and scoped to APIs and
  # their stages in the production region.
  statement {
    sid    = "TagOnlyApiGatewayApisAndStages"
    effect = "Allow"
    actions = [
      "apigateway:TagResource",
      "apigateway:UntagResource",
    ]
    resources = [
      "arn:aws:apigateway:${var.aws_region}::/apis/*",
      "arn:aws:apigateway:${var.aws_region}::/apis/*/stages",
      "arn:aws:apigateway:${var.aws_region}::/apis/*/stages/*",
    ]
  }

  statement {
    sid    = "ManageOnlySpawnpointIdentities"
    effect = "Allow"
    actions = [
      "iam:AddRoleToInstanceProfile",
      "iam:CreateInstanceProfile",
      "iam:CreateRole",
      "iam:DeleteRole",
      "iam:DeleteRolePolicy",
      "iam:DetachRolePolicy",
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
    sid     = "TagOnlyReleaseBuilderSources"
    effect  = "Allow"
    actions = ["s3:PutObjectTagging"]
    resources = [
      "arn:aws:s3:::spawnpoint-releases-${data.aws_caller_identity.current.account_id}/control-plane/release-builder/*",
    ]
  }

  # The one opening in the no-delete rule, and exactly as wide as the allow-list
  # in scripts/_terraform-destroy-allow.sh: control-plane wiring Terraform
  # recreates from the repository. Nothing here can reach the host, its volume,
  # a bucket, a table, the OIDC trust, the distribution, a Function URL or the
  # guardrails, so a wrong line in a destroy-allowed.txt stops at IAM.
  statement {
    sid    = "DestroyOnlyAllowListedWiring"
    effect = "Allow"
    actions = [
      "apigateway:DELETE",
      "cloudwatch:DeleteAlarms",
      "codebuild:DeleteProject",
      "events:DeleteRule",
      "events:RemoveTargets",
      "lambda:RemovePermission",
      "logs:DeleteLogGroup",
      "s3:DeleteObject",
      "s3:DeleteObjectVersion",
      "sns:Unsubscribe",
      "states:DeleteStateMachine",
    ]
    resources = [
      "arn:aws:apigateway:${var.aws_region}::/apis/*/integrations/*",
      "arn:aws:apigateway:${var.aws_region}::/apis/*/routes/*",
      "arn:aws:cloudwatch:${var.aws_region}:${data.aws_caller_identity.current.account_id}:alarm:spawnpoint-*",
      "arn:aws:codebuild:${var.aws_region}:${data.aws_caller_identity.current.account_id}:project/spawnpoint-*",
      "arn:aws:events:${var.aws_region}:${data.aws_caller_identity.current.account_id}:rule/spawnpoint-*",
      "arn:aws:lambda:${var.aws_region}:${data.aws_caller_identity.current.account_id}:function:spawnpoint-*",
      "arn:aws:logs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:log-group:*spawnpoint*",
      "arn:aws:s3:::spawnpoint-releases-${data.aws_caller_identity.current.account_id}/control-plane/release-builder/*",
      "arn:aws:sns:${var.aws_region}:${data.aws_caller_identity.current.account_id}:spawnpoint-*",
      "arn:aws:states:${var.aws_region}:${data.aws_caller_identity.current.account_id}:stateMachine:spawnpoint-*",
    ]
  }

  statement {
    sid    = "NeverDestroyGitHubIdentities"
    effect = "Deny"
    actions = [
      "iam:DeleteRole",
      "iam:DeleteRolePolicy",
      "iam:DetachRolePolicy",
    ]
    resources = ["arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/spawnpoint-github-*"]
  }

  statement {
    sid       = "NeverMutateTheIdentityAdmin"
    effect    = "Deny"
    actions   = ["iam:*"]
    resources = ["arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/spawnpoint-github-identity-admin"]
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

data "aws_iam_policy_document" "github_plan_assume_role" {
  statement {
    sid     = "OnlyOwnerReviewedPullRequestPlans"
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
      values   = [local.plan_subject]
    }
  }
}

resource "aws_iam_role" "github_plan" {
  name                 = "spawnpoint-github-plan"
  description          = "Reads Spawnpoint production state for owner-reviewed pull request plans; it cannot apply or lock."
  assume_role_policy   = data.aws_iam_policy_document.github_plan_assume_role.json
  max_session_duration = 3600

  tags = {
    Name    = "spawnpoint-github-plan"
    Purpose = "pull-request-terraform-plan"
  }
}

data "aws_iam_policy_document" "github_plan_iam" {
  statement {
    sid    = "ReadProductionStateWithoutLockWrites"
    effect = "Allow"
    actions = [
      "s3:GetObject",
      "s3:ListBucket",
    ]
    resources = [
      "arn:aws:s3:::spawnpoint-tfstate-${data.aws_caller_identity.current.account_id}",
      "arn:aws:s3:::spawnpoint-tfstate-${data.aws_caller_identity.current.account_id}/spawnpoint/*",
    ]
  }

  # Terraform refreshes the release builder's source bundle — an aws_s3_object
  # under control-plane/ in the releases bucket — on every plan of that root.
  # Reading that prefix is the whole of the plan identity's object access: no
  # releases/*, worlds/*, or presets/* payloads, and never a write.
  statement {
    sid       = "ReadTerraformManagedControlPlaneObjects"
    effect    = "Allow"
    actions   = ["s3:GetObject", "s3:GetObjectTagging"]
    resources = ["arn:aws:s3:::spawnpoint-releases-${data.aws_caller_identity.current.account_id}/control-plane/*"]
  }

  statement {
    sid    = "ReadExistingInfrastructureOnly"
    effect = "Allow"
    actions = [
      "apigateway:GET",
      "acm:DescribeCertificate",
      "acm:ListCertificates",
      "acm:ListTagsForCertificate",
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
      "route53:Get*",
      "route53:List*",
      "s3:GetAccelerateConfiguration",
      "s3:GetBucket*",
      "s3:GetEncryptionConfiguration",
      "s3:GetLifecycleConfiguration",
      "s3:GetReplicationConfiguration",
      "s3:ListAllMyBuckets",
      "s3:ListBucket",
      "sns:Get*",
      "sns:List*",
      "states:Describe*",
      "states:List*",
      "states:ValidateStateMachineDefinition",
      "sts:GetCallerIdentity",
    ]
    resources = ["*"]
  }

  statement {
    sid       = "ReadOnlyAmazonLinuxAmiParameter"
    effect    = "Allow"
    actions   = ["ssm:GetParameter"]
    resources = ["arn:aws:ssm:${var.aws_region}::parameter/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64"]
  }
}

resource "aws_iam_role_policy" "github_plan_iam" {
  name   = "spawnpoint-github-plan-read-only"
  role   = aws_iam_role.github_plan.id
  policy = data.aws_iam_policy_document.github_plan_iam.json
}
