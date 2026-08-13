data "aws_availability_zone" "selected" {
  name = var.availability_zone
}

data "aws_caller_identity" "current" {}

data "aws_ssm_parameter" "amazon_linux_2023_ami" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64"
}
