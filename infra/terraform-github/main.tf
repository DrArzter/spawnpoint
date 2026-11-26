data "aws_caller_identity" "current" {}

locals {
  github_subjects = var.github_subjects
  release_roles   = length(var.github_subjects) > 0 ? 1 : 0
  deploy_subject  = "${var.github_repository_subject}:environment:production"
  plan_subject    = "${var.github_repository_subject}:environment:production-plan"

  spawnpoint_ssm_documents         = "arn:aws:ssm:${var.aws_region}:${data.aws_caller_identity.current.account_id}:document/spawnpoint-*"
  host_app_commit_parameter        = "arn:aws:ssm:${var.aws_region}:${data.aws_caller_identity.current.account_id}:parameter/spawnpoint/host/app-commit"
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

# The release role exists only while a config repository may use it.
data "aws_iam_policy_document" "github_actions_assume_role" {
  count = local.release_roles

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
  count                = local.release_roles
  name                 = "spawnpoint-github-release"
  description          = "Lets the config repository request and observe one release-build workflow."
  assume_role_policy   = data.aws_iam_policy_document.github_actions_assume_role[0].json
  max_session_duration = 3600

  tags = {
    Name    = "spawnpoint-github-release"
    Purpose = "release-build-trigger"
  }
}

data "aws_iam_policy_document" "github_release" {
  count = local.release_roles

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
  count  = local.release_roles
  name   = "spawnpoint-github-release"
  role   = aws_iam_role.github_release[0].id
  policy = data.aws_iam_policy_document.github_release[0].json
}

moved {
  from = aws_iam_role.github_release
  to   = aws_iam_role.github_release[0]
}

moved {
  from = aws_iam_role_policy.github_release
  to   = aws_iam_role_policy.github_release[0]
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
      "ses:GetEmailIdentity",
      "ses:ListTagsForResource",
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
      # The log assistant's worker is never retried (ADR-0094).
      "lambda:PutFunctionEventInvokeConfig",
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

  # The SES sender identity of the access-api root. Creating and tagging
  # only; removing one goes through the destroy allow-list.
  statement {
    sid    = "ManageOnlySesEmailIdentities"
    effect = "Allow"
    actions = [
      "ses:CreateEmailIdentity",
      "ses:TagResource",
    ]
    resources = ["arn:aws:ses:${var.aws_region}:${data.aws_caller_identity.current.account_id}:identity/*"]
  }

  # Spawnpoint's own SSM documents, the console's and the whitelist's
  # (ADR-0063, ADR-0066), and no other document. Removing one goes through
  # the destroy allow-list like any other destroy.
  statement {
    sid    = "ManageOnlySpawnpointSsmDocuments"
    effect = "Allow"
    actions = [
      "ssm:AddTagsToResource",
      "ssm:CreateDocument",
      "ssm:GetDocument",
      "ssm:ListTagsForResource",
      "ssm:RemoveTagsFromResource",
      "ssm:UpdateDocument",
      "ssm:UpdateDocumentDefaultVersion",
    ]
    resources = [local.spawnpoint_ssm_documents]
  }

  # The commit a host brings its checkout to before a session starts
  # (ADR-0067). One parameter, written on every access API apply.
  statement {
    sid    = "WriteOnlyTheHostAppCommitParameter"
    effect = "Allow"
    actions = [
      "ssm:AddTagsToResource",
      "ssm:ListTagsForResource",
      "ssm:PutParameter",
      "ssm:RemoveTagsFromResource",
    ]
    resources = [local.host_app_commit_parameter]
  }

  # EC2 creates a default allow-all egress rule with every security group.
  # Terraform must revoke it before installing the reviewed game-port rules.
  statement {
    sid    = "ManageOnlyTaggedSpawnpointSecurityGroupRules"
    effect = "Allow"
    actions = [
      "ec2:AuthorizeSecurityGroupEgress",
      "ec2:AuthorizeSecurityGroupIngress",
      "ec2:RevokeSecurityGroupEgress",
      "ec2:RevokeSecurityGroupIngress",
    ]
    resources = ["arn:aws:ec2:${var.aws_region}:${data.aws_caller_identity.current.account_id}:security-group/sg-*"]

    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/Project"
      values   = ["spawnpoint"]
    }
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

  # API Gateway sends a stage's access log through CloudWatch Logs vended
  # delivery. UpdateStage checks these on the caller, and they take no
  # resource-level scope.
  statement {
    sid    = "DeliverApiGatewayAccessLogs"
    effect = "Allow"
    actions = [
      "logs:CreateLogDelivery",
      "logs:DeleteLogDelivery",
      "logs:DescribeResourcePolicies",
      "logs:GetLogDelivery",
      "logs:ListLogDeliveries",
      "logs:PutResourcePolicy",
      "logs:UpdateLogDelivery",
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

  # ADR-0102: EC2 needs this role to launch Spot capacity. Only this one
  # service may be named; the deploy identity may not delete it.
  statement {
    sid       = "CreateOnlyTheSpotServiceLinkedRole"
    effect    = "Allow"
    actions   = ["iam:CreateServiceLinkedRole"]
    resources = ["arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/aws-service-role/spot.amazonaws.com/AWSServiceRoleForEC2Spot"]

    condition {
      test     = "StringEquals"
      variable = "iam:AWSServiceName"
      values   = ["spot.amazonaws.com"]
    }
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
      "ses:GetEmailIdentity",
      "ses:ListTagsForResource",
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
    sid    = "ReadOnlySpawnpointSsmDocuments"
    effect = "Allow"
    actions = [
      "ssm:DescribeDocument",
      "ssm:DescribeDocumentPermission",
      "ssm:GetDocument",
      "ssm:ListTagsForResource",
    ]
    resources = [local.spawnpoint_ssm_documents]
  }

  statement {
    sid       = "ReadOnlyTheHostAppCommitParameter"
    effect    = "Allow"
    actions   = ["ssm:GetParameter", "ssm:ListTagsForResource"]
    resources = [local.host_app_commit_parameter]
  }

  # DescribeParameters takes no resource; it lists names and metadata, not values.
  statement {
    sid       = "DescribeParameters"
    effect    = "Allow"
    actions   = ["ssm:DescribeParameters"]
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
