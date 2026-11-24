# Release construction has its own lifecycle and state; it does not depend on
# the disposable game host.
locals {
  curseforge_api_key_parameter_name = "/spawnpoint/releases/curseforge-api-key"
  release_builder_log_group_name    = "/aws/codebuild/spawnpoint-release-builder"
}

data "archive_file" "release_builder_source" {
  type        = "zip"
  output_path = "${path.module}/.terraform/release-builder.zip"

  source {
    content  = file("${path.module}/release-builder.buildspec.yml")
    filename = "buildspec.yml"
  }

  source {
    content  = file("${path.module}/../../scripts/aws-release-builder.sh")
    filename = "scripts/aws-release-builder.sh"
  }

  source {
    content  = file("${path.module}/../../scripts/aws-preset-catalog-builder.sh")
    filename = "scripts/aws-preset-catalog-builder.sh"
  }

  source {
    content  = file("${path.module}/../../scripts/_config-source.sh")
    filename = "scripts/_config-source.sh"
  }

  # Holders for the catalog (ADR-0080).
  source {
    content  = file("${path.module}/../../scripts/_release-holders.sh")
    filename = "scripts/_release-holders.sh"
  }

  source {
    content  = file("${path.module}/../../scripts/config-sources/github-snapshot.sh")
    filename = "scripts/config-sources/github-snapshot.sh"
  }

  source {
    content  = file("${path.module}/../../server/scripts/_common.sh")
    filename = "server/scripts/_common.sh"
  }

  source {
    content  = file("${path.module}/../../server/scripts/_s3.sh")
    filename = "server/scripts/_s3.sh"
  }

  # The upstream cache the resolvers share (incremental builds, stage 3).
  source {
    content  = file("${path.module}/../../server/scripts/_upstream-cache.sh")
    filename = "server/scripts/_upstream-cache.sh"
  }

  source {
    content  = file("${path.module}/../../server/scripts/_profiles.sh")
    filename = "server/scripts/_profiles.sh"
  }

  # _profiles.sh reads a game's release facts from its manifest (ADR-0088).
  dynamic "source" {
    for_each = fileset("${path.module}/../../server/games", "*/game.json")
    content {
      content  = file("${path.module}/../../server/games/${source.value}")
      filename = "server/games/${source.value}"
    }
  }

  source {
    content  = file("${path.module}/../../server/scripts/resolve-profile-mods.sh")
    filename = "server/scripts/resolve-profile-mods.sh"
  }

  source {
    content  = file("${path.module}/../../server/scripts/resolve-curseforge-modpack.sh")
    filename = "server/scripts/resolve-curseforge-modpack.sh"
  }

  # Addons on top of a modpack (ADR-0077): pinned downloads, the C1-C8 checks
  # and the extended client pack.
  source {
    content  = file("${path.module}/../../server/scripts/resolve-addons.sh")
    filename = "server/scripts/resolve-addons.sh"
  }

  source {
    content  = file("${path.module}/../../server/scripts/check-mod-set.sh")
    filename = "server/scripts/check-mod-set.sh"
  }

  source {
    content  = file("${path.module}/../../server/scripts/extend-client-pack.sh")
    filename = "server/scripts/extend-client-pack.sh"
  }

  # The factorio resolver is a game module rather than a container, so the
  # bundle carries it the way it carries the shared scripts.
  source {
    content  = file("${path.module}/../../server/games/factorio/resolve-mods.sh")
    filename = "server/games/factorio/resolve-mods.sh"
  }

  source {
    content  = file("${path.module}/../../server/scripts/build-profile-release.sh")
    filename = "server/scripts/build-profile-release.sh"
  }

  source {
    content  = file("${path.module}/../../server/scripts/build-release-manifest.sh")
    filename = "server/scripts/build-release-manifest.sh"
  }

  source {
    content  = file("${path.module}/../../server/scripts/plan-release.sh")
    filename = "server/scripts/plan-release.sh"
  }

  source {
    content  = file("${path.module}/../../server/scripts/upload-release.sh")
    filename = "server/scripts/upload-release.sh"
  }

  # The objects-v1 writer (ADR-0080): one bundled Node program, built by
  # lambdas/scripts/build.sh. The file must exist when Terraform plans.
  source {
    content  = file("${path.module}/../../lambdas/dist/release-writer/index.cjs")
    filename = "tools/release-writer.cjs"
  }
}

resource "aws_s3_object" "release_builder_source" {
  bucket                 = data.aws_s3_bucket.releases.id
  key                    = "control-plane/release-builder/${data.archive_file.release_builder_source.output_sha256}.zip"
  source                 = data.archive_file.release_builder_source.output_path
  source_hash            = data.archive_file.release_builder_source.output_sha256
  server_side_encryption = "AES256"

  tags = {
    Name    = "spawnpoint-release-builder-source"
    Purpose = "reviewed-codebuild-input"
  }

  lifecycle {
    create_before_destroy = true
  }
}

data "aws_iam_policy_document" "codebuild_assume_role" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["codebuild.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "release_builder" {
  name               = "spawnpoint-release-builder"
  assume_role_policy = data.aws_iam_policy_document.codebuild_assume_role.json

  tags = {
    Name = "spawnpoint-release-builder"
  }
}

resource "aws_cloudwatch_log_group" "release_builder" {
  name              = local.release_builder_log_group_name
  retention_in_days = 14

  tags = {
    Name = "spawnpoint-release-builder"
  }
}

data "aws_iam_policy_document" "release_builder" {
  statement {
    sid     = "ReadCurseForgeKey"
    actions = ["ssm:GetParameters"]
    resources = [
      "arn:aws:ssm:${var.aws_region}:${data.aws_caller_identity.current.account_id}:parameter${local.curseforge_api_key_parameter_name}",
    ]
  }

  statement {
    sid = "PublishImmutableReleases"
    actions = [
      "s3:GetObject",
      "s3:PutObject",
    ]
    resources = [
      "${data.aws_s3_bucket.releases.arn}/releases/*",
      "${data.aws_s3_bucket.releases.arn}/presets/*",
    ]
  }

  # The preset catalog lists the published releases of its game, to find a
  # release that a catalog without history had forgotten (ADR-0042). Listing is
  # limited to the release prefix; a missing key then answers 404, which the
  # upstream cache reads as a miss like the 403 it saw before.
  statement {
    sid       = "ListPublishedReleases"
    actions   = ["s3:ListBucket"]
    resources = [data.aws_s3_bucket.releases.arn]
    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["releases/*"]
    }
  }

  # Verified upstream bytes and their index (incremental builds, stage 3). No
  # delete: the storage root's lifecycle expires the prefix.
  statement {
    sid = "CacheUpstreamFiles"
    actions = [
      "s3:GetObject",
      "s3:PutObject",
    ]
    resources = ["${data.aws_s3_bucket.releases.arn}/upstream/*"]
  }

  # Content-addressed objects (ADR-0080). A copy from upstream/ into objects/
  # needs the read above and this write. No delete: only the reconciler deletes
  # an object, and the bucket policy denies everyone else.
  statement {
    sid = "WriteContentAddressedObjects"
    actions = [
      "s3:GetObject",
      "s3:PutObject",
    ]
    resources = ["${data.aws_s3_bucket.releases.arn}/objects/*"]
  }

  # The reference table (ADR-0080): the actions that ReleaseRefs sends, on this
  # one table. A transaction needs no action of its own; no scan, no query.
  statement {
    sid = "UpdateReleaseReferences"
    actions = [
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
      "dynamodb:DeleteItem",
    ]
    resources = ["arn:aws:dynamodb:${var.aws_region}:${data.aws_caller_identity.current.account_id}:table/${var.release_refs_table_name}"]
  }

  statement {
    sid       = "ReadReviewedBuilderSource"
    actions   = ["s3:GetObject"]
    resources = [aws_s3_object.release_builder_source.arn]
  }

  statement {
    sid       = "ReadGitConfigSnapshots"
    actions   = ["s3:GetObject"]
    resources = ["${data.aws_s3_bucket.releases.arn}/config-sources/*"]
  }

  statement {
    sid = "WriteOnlyOwnLogs"
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = ["${aws_cloudwatch_log_group.release_builder.arn}:*"]
  }
}

resource "aws_iam_role_policy" "release_builder" {
  name   = "spawnpoint-release-builder"
  role   = aws_iam_role.release_builder.id
  policy = data.aws_iam_policy_document.release_builder.json
}

resource "aws_codebuild_project" "release_builder" {
  name                   = "spawnpoint-release-builder"
  description            = "Resolve a pinned profile in AWS and publish an inert immutable release candidate."
  service_role           = aws_iam_role.release_builder.arn
  build_timeout          = 60
  queued_timeout         = 60
  concurrent_build_limit = 3

  source {
    type      = "S3"
    location  = "${data.aws_s3_bucket.releases.id}/${aws_s3_object.release_builder_source.key}"
    buildspec = "buildspec.yml"
  }

  artifacts {
    type = "NO_ARTIFACTS"
  }

  environment {
    compute_type                = "BUILD_GENERAL1_SMALL"
    image                       = "aws/codebuild/standard:7.0"
    type                        = "LINUX_CONTAINER"
    image_pull_credentials_type = "CODEBUILD"
    privileged_mode             = true

    environment_variable {
      name  = "CF_API_KEY"
      type  = "PARAMETER_STORE"
      value = local.curseforge_api_key_parameter_name
    }

    environment_variable {
      name  = "RELEASE_BUCKET"
      value = data.aws_s3_bucket.releases.id
    }

    # `legacy` keeps today's per-release keys; `objects-v1` writes
    # content-addressed objects (ADR-0080) and stays off until the readers are
    # deployed.
    environment_variable {
      name  = "RELEASE_STORAGE_LAYOUT"
      value = var.release_storage_layout
    }

    environment_variable {
      name  = "RELEASE_REFS_TABLE"
      value = var.release_refs_table_name
    }

    # The current installation enables one adapter. Future sources add another
    # adapter without changing the shared catalog or release builders.
    environment_variable {
      name  = "CONFIG_SOURCE_KIND"
      value = "github-snapshot"
    }

    # One authoring repository per game, so the caller names it. The builder's
    # allow-list decides which names are acceptable.
    environment_variable {
      name  = "CONFIG_REPOSITORY_URL"
      value = "REQUIRED_BY_CALLER"
    }

    environment_variable {
      name  = "CONFIG_COMMIT"
      value = "REQUIRED_BY_CALLER"
    }

    environment_variable {
      name  = "CONFIG_SOURCE_KEY"
      value = "REQUIRED_BY_CALLER"
    }

    environment_variable {
      name  = "CONFIG_SOURCE_SHA256"
      value = "REQUIRED_BY_CALLER"
    }

    environment_variable {
      name  = "PROFILE_ID"
      value = "REQUIRED_BY_CALLER"
    }

    environment_variable {
      name  = "RELEASE"
      value = "REQUIRED_BY_CALLER"
    }
  }

  logs_config {
    cloudwatch_logs {
      group_name  = aws_cloudwatch_log_group.release_builder.name
      stream_name = "build"
    }
  }

  depends_on = [
    aws_iam_role_policy.release_builder,
    aws_s3_object.release_builder_source,
  ]

  tags = {
    Name    = "spawnpoint-release-builder"
    Purpose = "immutable-release-candidate"
  }
}

resource "aws_iam_role" "build_release_workflow" {
  name               = "spawnpoint-build-release"
  assume_role_policy = data.aws_iam_policy_document.step_functions_assume_role.json

  tags = {
    Name = "spawnpoint-build-release"
  }
}

data "aws_iam_policy_document" "build_release_workflow" {
  statement {
    sid = "RunOnlyReleaseBuilder"
    actions = [
      "codebuild:BatchGetBuilds",
      "codebuild:StartBuild",
      "codebuild:StopBuild",
    ]
    resources = [aws_codebuild_project.release_builder.arn]
  }

  statement {
    sid = "ManagedRuleForSynchronousBuild"
    actions = [
      "events:DescribeRule",
      "events:PutRule",
      "events:PutTargets",
    ]
    resources = [
      "arn:aws:events:${var.aws_region}:${data.aws_caller_identity.current.account_id}:rule/StepFunctionsGetEventForCodeBuildStartBuildRule",
    ]
  }
}

resource "aws_iam_role_policy" "build_release_workflow" {
  name   = "spawnpoint-build-release"
  role   = aws_iam_role.build_release_workflow.id
  policy = data.aws_iam_policy_document.build_release_workflow.json
}

resource "aws_sfn_state_machine" "build_release" {
  name     = "spawnpoint-build-release"
  role_arn = aws_iam_role.build_release_workflow.arn
  type     = "STANDARD"
  definition = templatefile("${path.module}/../../workflows/build-release.asl.json.tftpl", {
    project_name = aws_codebuild_project.release_builder.name
  })

  tags = {
    Name    = "spawnpoint-build-release"
    Purpose = "immutable-release-candidate-build"
  }
}

resource "aws_sfn_state_machine" "publish_preset_catalog" {
  name     = "spawnpoint-publish-preset-catalog"
  role_arn = aws_iam_role.build_release_workflow.arn
  type     = "STANDARD"
  definition = templatefile("${path.module}/../../workflows/publish-preset-catalog.asl.json.tftpl", {
    project_name = aws_codebuild_project.release_builder.name
  })

  tags = {
    Name    = "spawnpoint-publish-preset-catalog"
    Purpose = "git-preset-discovery"
  }
}
