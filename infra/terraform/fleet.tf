# A host the control plane launches for a session (ADR-0054, phase 12), as
# opposed to the one instance Terraform declares in compute.tf. Nothing that
# outlives a session lives on it: the app is checked out at first boot, the
# runtime environment is rendered from Parameter Store, worlds are restored
# from S3 and archived back before the host is let go. The instance type is
# not named here — an instant EC2 Fleet chooses it from the footprint's
# requirements at launch time — which is why this is a template and not an
# instance.
resource "aws_launch_template" "fleet_host" {
  name                   = "spawnpoint-fleet-host"
  description            = "Spawnpoint game host launched for a session; terminated when its last session leaves"
  update_default_version = true

  image_id = data.aws_ssm_parameter.amazon_linux_2023_ami.value

  iam_instance_profile {
    name = aws_iam_instance_profile.game_host.name
  }

  network_interfaces {
    associate_public_ip_address = true
    subnet_id                   = aws_subnet.public.id
    security_groups             = [aws_security_group.game_host.id]
    delete_on_termination       = true
  }

  # A launched host that shuts itself down is gone, not parked: there is no
  # volume worth keeping on it.
  instance_initiated_shutdown_behavior = "terminate"

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
    # The bootstrap reads AppCommit from its own tags.
    instance_metadata_tags = "enabled"
  }

  block_device_mappings {
    device_name = "/dev/xvda"

    ebs {
      volume_size           = var.fleet_root_volume_gib
      volume_type           = "gp3"
      encrypted             = true
      delete_on_termination = true
    }
  }

  user_data = base64encode(templatefile("${path.module}/../../server/user-data-fleet.sh.tftpl", {
    base                = file("${path.module}/../../server/user-data.sh")
    repository_url      = var.repository_url
    host_parameter_path = var.host_parameter_path
  }))

  tag_specifications {
    resource_type = "instance"
    tags          = local.fleet_host_tags
  }

  tag_specifications {
    resource_type = "volume"
    tags          = local.fleet_host_tags
  }

  tags = {
    Name = "spawnpoint-fleet-host"
  }
}

locals {
  # ManagedBy is the tag every IAM statement about launched hosts conditions on:
  # the machines may start, stop, command and terminate a host that carries it,
  # and the configured instance never does.
  fleet_host_tags = {
    Name         = "spawnpoint-fleet-host"
    Purpose      = "game-host"
    ManagedBy    = "spawnpoint-fleet"
    PurchaseMode = "on-demand"
  }
  fleet_host_instance_arn_pattern = "arn:aws:ec2:${var.aws_region}:${data.aws_caller_identity.current.account_id}:instance/*"
}

# A launched host renders its runtime environment from Parameter Store: the
# same keys the configured host keeps in its .env, one parameter each under
# <host_parameter_path>/env, plus the overlay's Central API token so the host
# can authorise its own membership. The AWS-managed SSM key decrypts them.
data "aws_iam_policy_document" "game_host_parameters" {
  statement {
    sid = "ReadHostParameters"
    actions = [
      "ssm:GetParameter",
      "ssm:GetParameters",
      "ssm:GetParametersByPath",
    ]
    resources = [
      "arn:aws:ssm:${var.aws_region}:${data.aws_caller_identity.current.account_id}:parameter${var.host_parameter_path}",
      "arn:aws:ssm:${var.aws_region}:${data.aws_caller_identity.current.account_id}:parameter${var.host_parameter_path}/*",
    ]
  }
}

resource "aws_iam_role_policy" "game_host_parameters" {
  name   = "spawnpoint-game-host-parameters"
  role   = aws_iam_role.game_host.id
  policy = data.aws_iam_policy_document.game_host_parameters.json
}
