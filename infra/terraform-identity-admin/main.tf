data "aws_caller_identity" "current" {}

# The trust anchor of the deployment pipeline. The identity defined here may
# change the GitHub identities in ../terraform-github and nothing else, and
# nothing in that root — or in any pipeline run — can change this one: it is
# applied by hand, its own ARN is denied to itself, and the deployment identity
# is denied from touching it. Everything else the pipeline does can therefore
# be automated without the automation being able to widen its own reach.
locals {
  account_id         = data.aws_caller_identity.current.account_id
  identity_subject   = "repo:DrArzter@102290466/spawnpoint@1330947749:environment:production-identity"
  oidc_provider_arn  = "arn:aws:iam::${local.account_id}:oidc-provider/token.actions.githubusercontent.com"
  github_roles_arn   = "arn:aws:iam::${local.account_id}:role/spawnpoint-github-*"
  self_arn           = "arn:aws:iam::${local.account_id}:role/spawnpoint-github-identity-admin"
  state_bucket_arn   = "arn:aws:s3:::spawnpoint-tfstate-${local.account_id}"
  identity_state_arn = "${local.state_bucket_arn}/spawnpoint/github-oidc.tfstate"
}

# The OIDC provider itself is owned by ../terraform-github; this root names its
# ARN and owns nothing that root manages, so neither can rewrite the other.
data "aws_iam_policy_document" "identity_admin_assume_role" {
  statement {
    sid     = "OnlyOwnerApprovedIdentityRuns"
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [local.oidc_provider_arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = [local.identity_subject]
    }
  }
}

resource "aws_iam_role" "github_identity_admin" {
  name                 = "spawnpoint-github-identity-admin"
  description          = "Applies infra/terraform-github from the owner-approved production-identity environment; changes no other identity and never itself."
  assume_role_policy   = data.aws_iam_policy_document.identity_admin_assume_role.json
  max_session_duration = 3600

  tags = {
    Name    = "spawnpoint-github-identity-admin"
    Purpose = "github-identity-apply"
  }
}

data "aws_iam_policy_document" "identity_admin" {
  statement {
    sid       = "ReadAndWriteOnlyTheIdentityState"
    effect    = "Allow"
    actions   = ["s3:GetObject", "s3:PutObject"]
    resources = [local.identity_state_arn, "${local.identity_state_arn}.tflock"]
  }

  statement {
    sid       = "ListTheStateBucket"
    effect    = "Allow"
    actions   = ["s3:ListBucket"]
    resources = [local.state_bucket_arn]
  }

  statement {
    sid       = "ReleaseOnlyTheIdentityLock"
    effect    = "Allow"
    actions   = ["s3:DeleteObject"]
    resources = ["${local.identity_state_arn}.tflock"]
  }

  # Create and update, never delete: retiring an identity is a hand apply.
  statement {
    sid    = "ManageOnlyTheGitHubIdentities"
    effect = "Allow"
    actions = [
      "iam:CreateRole",
      "iam:GetRole",
      "iam:GetRolePolicy",
      "iam:ListAttachedRolePolicies",
      "iam:ListInstanceProfilesForRole",
      "iam:ListRolePolicies",
      "iam:ListRoleTags",
      "iam:PutRolePolicy",
      "iam:TagRole",
      "iam:UntagRole",
      "iam:UpdateAssumeRolePolicy",
      "iam:UpdateRole",
      "iam:UpdateRoleDescription",
    ]
    resources = [local.github_roles_arn]
  }

  statement {
    sid    = "ManageOnlyTheGitHubOidcProvider"
    effect = "Allow"
    actions = [
      "iam:AddClientIDToOpenIDConnectProvider",
      "iam:CreateOpenIDConnectProvider",
      "iam:GetOpenIDConnectProvider",
      "iam:ListOpenIDConnectProviderTags",
      "iam:RemoveClientIDFromOpenIDConnectProvider",
      "iam:TagOpenIDConnectProvider",
      "iam:UntagOpenIDConnectProvider",
      "iam:UpdateOpenIDConnectProviderThumbprint",
    ]
    resources = [local.oidc_provider_arn]
  }

  statement {
    sid       = "KnowWhoItIs"
    effect    = "Allow"
    actions   = ["sts:GetCallerIdentity"]
    resources = ["*"]
  }

  # Its own trust and permissions live in this root, applied by hand. The deny
  # keeps a run of the identity job away from them even if the allow above were
  # ever widened by mistake: its name matches spawnpoint-github-*.
  statement {
    sid       = "NeverTouchItself"
    effect    = "Deny"
    actions   = ["iam:*"]
    resources = [local.self_arn]
  }
}

resource "aws_iam_role_policy" "github_identity_admin" {
  name   = "spawnpoint-github-identity-admin"
  role   = aws_iam_role.github_identity_admin.id
  policy = data.aws_iam_policy_document.identity_admin.json
}
