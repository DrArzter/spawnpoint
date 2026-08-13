resource "aws_ebs_volume" "data" {
  availability_zone = var.availability_zone
  encrypted         = true
  size              = var.data_volume_size_gib
  type              = "gp3"

  tags = {
    Name    = "spawnpoint-data"
    Purpose = "persistent-game-data"
  }

  lifecycle {
    precondition {
      condition     = data.aws_availability_zone.selected.zone_id == var.availability_zone_id
      error_message = "The data volume must stay in the reviewed physical Availability Zone."
    }
  }
}

resource "aws_instance" "game_host" {
  ami                                  = data.aws_ssm_parameter.amazon_linux_2023_ami.value
  instance_type                        = var.instance_type
  availability_zone                    = var.availability_zone
  subnet_id                            = aws_subnet.public.id
  vpc_security_group_ids               = [aws_security_group.game_host.id]
  associate_public_ip_address          = true
  iam_instance_profile                 = aws_iam_instance_profile.game_host.name
  disable_api_termination              = true
  instance_initiated_shutdown_behavior = "stop"
  user_data                            = file("${path.module}/../../server/user-data.sh")
  user_data_replace_on_change          = true

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
    instance_metadata_tags      = "enabled"
  }

  root_block_device {
    delete_on_termination = true
    encrypted             = true
    volume_size           = 8
    volume_type           = "gp3"

    tags = {
      Name    = "spawnpoint-root"
      Purpose = "disposable-root"
    }
  }

  tags = {
    Name         = "spawnpoint-game-host"
    Purpose      = "minecraft-session-host"
    PurchaseMode = "on-demand"
  }

  depends_on = [
    aws_iam_role_policy_attachment.ssm_core,
    aws_route_table_association.public,
  ]

  lifecycle {
    precondition {
      condition     = data.aws_availability_zone.selected.zone_id == var.availability_zone_id
      error_message = "The instance and persistent EBS must use the same reviewed physical Availability Zone."
    }
  }
}

resource "aws_volume_attachment" "data" {
  device_name                    = "/dev/sdf"
  instance_id                    = aws_instance.game_host.id
  volume_id                      = aws_ebs_volume.data.id
  stop_instance_before_detaching = true
}

