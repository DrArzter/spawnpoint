data "aws_iam_policy_document" "ec2_assume_role" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "game_host" {
  name               = "spawnpoint-game-host"
  assume_role_policy = data.aws_iam_policy_document.ec2_assume_role.json

  tags = {
    Name = "spawnpoint-game-host"
  }
}

resource "aws_iam_role_policy_attachment" "ssm_core" {
  role       = aws_iam_role.game_host.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

data "aws_iam_policy_document" "game_host_storage" {
  statement {
    sid = "ListStoragePrefixes"

    actions = ["s3:ListBucket"]
    resources = [
      aws_s3_bucket.backups.arn,
      aws_s3_bucket.releases.arn,
    ]
  }

  statement {
    sid = "WriteAndVerifyBackups"

    actions = [
      "s3:AbortMultipartUpload",
      "s3:GetObject",
      "s3:PutObject",
    ]
    resources = ["${aws_s3_bucket.backups.arn}/*"]
  }

  statement {
    sid       = "ReadReleases"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.releases.arn}/releases/*"]
  }
}

resource "aws_iam_role_policy" "game_host_storage" {
  name   = "spawnpoint-game-host-storage"
  role   = aws_iam_role.game_host.id
  policy = data.aws_iam_policy_document.game_host_storage.json
}

resource "aws_iam_instance_profile" "game_host" {
  name = "spawnpoint-game-host"
  role = aws_iam_role.game_host.name
}
