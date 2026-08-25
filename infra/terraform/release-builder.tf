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
    content  = file("${path.module}/../../server/scripts/resolve-profile-mods.sh")
    filename = "server/scripts/resolve-profile-mods.sh"
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
    resources = ["${data.aws_s3_bucket.releases.arn}/releases/*"]
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

    environment_variable {
      name  = "CONFIG_REPOSITORY_URL"
      value = "https://github.com/DrArzter/my-docker-minecraft-server-config.git"
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
