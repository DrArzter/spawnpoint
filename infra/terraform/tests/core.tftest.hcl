mock_provider "aws" {
  override_during = plan

  override_data {
    target = data.aws_availability_zone.selected
    values = {
      name    = "eu-central-1a"
      zone_id = "euc1-az2"
    }
  }

  override_data {
    target = data.aws_ssm_parameter.amazon_linux_2023_ami
    values = {
      value = "ami-00000000000000000"
    }
  }

  override_data {
    target = data.aws_caller_identity.current
    values = {
      account_id = "123456789012"
    }
  }

  override_data {
    target = data.aws_s3_bucket.backups
    values = {
      id  = "spawnpoint-backups-123456789012"
      arn = "arn:aws:s3:::spawnpoint-backups-123456789012"
    }
  }

  override_data {
    target = data.aws_s3_bucket.releases
    values = {
      id  = "spawnpoint-releases-123456789012"
      arn = "arn:aws:s3:::spawnpoint-releases-123456789012"
    }
  }

  override_data {
    target = data.aws_iam_policy_document.ec2_assume_role
    values = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}"
    }
  }

  override_data {
    target = data.aws_iam_policy_document.game_host_storage
    values = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}"
    }
  }
}

run "free_plan_host_preserves_m0_invariants" {
  command = plan

  assert {
    condition     = aws_instance.game_host.instance_type == "m7i-flex.large"
    error_message = "The Free Plan host must remain m7i-flex.large until an explicit paid upgrade."
  }

  assert {
    condition     = length(aws_security_group.game_host.ingress) == 0
    error_message = "Mode C must not publish Minecraft, SSH or Grafana through the VPC security group."
  }

  assert {
    condition     = aws_instance.game_host.metadata_options[0].http_tokens == "required"
    error_message = "The instance must require IMDSv2 tokens."
  }

  assert {
    condition     = aws_instance.game_host.disable_api_termination
    error_message = "The game host must retain EC2 termination protection."
  }

  assert {
    condition     = aws_instance.game_host.root_block_device[0].encrypted && aws_instance.game_host.root_block_device[0].delete_on_termination
    error_message = "The disposable root volume must be encrypted and deleted with the instance."
  }

  assert {
    condition     = aws_ebs_volume.data.encrypted && aws_ebs_volume.data.size == 20
    error_message = "The persistent data EBS must be encrypted and start at the measured 20 GiB."
  }

  assert {
    condition     = aws_volume_attachment.data.device_name == "/dev/sdf" && aws_volume_attachment.data.stop_instance_before_detaching
    error_message = "The data volume must use the reviewed attachment contract and stop before detach."
  }

  assert {
    condition     = data.aws_s3_bucket.backups.id == "spawnpoint-backups-123456789012" && data.aws_s3_bucket.releases.id == "spawnpoint-releases-123456789012"
    error_message = "The compute stack must consume the separately managed persistent storage buckets."
  }
}

run "reviewed_paid_upgrade_is_explicit" {
  command = plan

  variables {
    instance_type = "r8i-flex.large"
  }

  assert {
    condition     = aws_instance.game_host.instance_type == "r8i-flex.large"
    error_message = "The reviewed 16 GiB upgrade must remain selectable without changing the topology."
  }
}

run "unreviewed_instance_type_is_rejected" {
  command = plan

  variables {
    instance_type = "m7i-flex.xlarge"
  }

  expect_failures = [var.instance_type]
}
