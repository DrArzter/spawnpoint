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
    content  = file("${path.module}/../../server/scripts/_common.sh")
    filename = "server/scripts/_common.sh"
  }

  source {
    content  = file("${path.module}/../../server/scripts/_s3.sh")
    filename = "server/scripts/_s3.sh"
  }

  source {
    content  = file("${path.module}/../../server/scripts/_profiles.sh")
    filename = "server/scripts/_profiles.sh"
  }

  # The pack-upload mode: its entrypoint, and the validator that treats an
  # uploaded archive as hostile.
  source {
    content  = file("${path.module}/../../scripts/aws-pack-upload-builder.sh")
    filename = "scripts/aws-pack-upload-builder.sh"
  }

  source {
    content  = file("${path.module}/../../server/scripts/extract-pack-upload.sh")
    filename = "server/scripts/extract-pack-upload.sh"
  }

  source {
    content  = file("${path.module}/../../server/scripts/resolve-profile-mods.sh")
    filename = "server/scripts/resolve-profile-mods.sh"
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
    content  = file("${path.module}/../../server/scripts/upload-release.sh")
    filename = "server/scripts/upload-release.sh"
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
      # The client pack is published alongside every release now.
      "${data.aws_s3_bucket.releases.arn}/packs/*",
    ]
  }

  statement {
    sid = "ConsumeUploadedPacks"
    actions = [
      "s3:GetObject",
      # The upload is deleted once its release exists: leaving it would keep a
      # second copy of every pack in the bucket.
      "s3:DeleteObject",
    ]
    resources = ["${data.aws_s3_bucket.releases.arn}/uploads/*"]
  }

  statement {
    sid       = "ReadReviewedBuilderSource"
    actions   = ["s3:GetObject"]
    resources = [aws_s3_object.release_builder_source.arn]
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
  build_timeout          = 30
  queued_timeout         = 60
  concurrent_build_limit = 1

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

resource "aws_sfn_state_machine" "publish_uploaded_pack" {
  name     = "spawnpoint-publish-uploaded-pack"
  role_arn = aws_iam_role.build_release_workflow.arn
  type     = "STANDARD"
  definition = templatefile("${path.module}/../../workflows/publish-uploaded-pack.asl.json.tftpl", {
    project_name = aws_codebuild_project.release_builder.name
  })

  tags = {
    Name    = "spawnpoint-publish-uploaded-pack"
    Purpose = "publish-release-from-uploaded-pack"
  }
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
