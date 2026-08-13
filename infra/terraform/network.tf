resource "aws_vpc" "main" {
  cidr_block           = "10.42.0.0/16"
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = {
    Name = "spawnpoint"
  }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id

  tags = {
    Name = "spawnpoint"
  }
}

resource "aws_subnet" "public" {
  vpc_id                  = aws_vpc.main.id
  availability_zone       = var.availability_zone
  cidr_block              = "10.42.0.0/24"
  map_public_ip_on_launch = true

  tags = {
    Name = "spawnpoint-public"
  }

  lifecycle {
    precondition {
      condition     = data.aws_availability_zone.selected.zone_id == var.availability_zone_id
      error_message = "The selected AZ name no longer maps to the reviewed physical Zone ID."
    }
  }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }

  tags = {
    Name = "spawnpoint-public"
  }
}

resource "aws_route_table_association" "public" {
  subnet_id      = aws_subnet.public.id
  route_table_id = aws_route_table.public.id
}

resource "aws_security_group" "game_host" {
  name        = "spawnpoint-game-host"
  description = "ZeroTier-only game host; deliberately no inbound rules"
  vpc_id      = aws_vpc.main.id
  ingress     = []

  egress {
    description = "Outbound bootstrap, SSM, registries and ZeroTier"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "spawnpoint-game-host"
  }
}

check "zero_public_ingress" {
  assert {
    condition     = length(aws_security_group.game_host.ingress) == 0
    error_message = "Mode C requires zero security-group ingress; Minecraft and Grafana are ZeroTier-only."
  }
}
