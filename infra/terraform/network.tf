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

locals {
  world_catalog = jsondecode(file("${path.module}/../../server/worlds/catalog.json"))

  # Worlds that reach players without the overlay. The gate-versus-auth
  # invariant (ADR-0033) is enforced on the host too, but a port opened here
  # would outlive a refused start, so it is checked where the port is made.
  public_worlds = [
    for world in local.world_catalog.worlds : {
      id   = world.id
      game = try(world.game, "minecraft")
      auth = try(world.auth, "")
      # The port lives in the game module and is read from it, so this is not a
      # fourth copy of a number that has to be kept in step by hand.
      port     = tonumber(regex("GAME_CONNECT_PORT=\"([0-9]+)\"", file("${path.module}/../../server/games/${try(world.game, "minecraft")}/game.sh"))[0])
      protocol = regex("GAME_CONNECT_PROTOCOL=\"([a-z]+)\"", file("${path.module}/../../server/games/${try(world.game, "minecraft")}/game.sh"))[0]
    }
    if try(world.connectivity, "zerotier") != "zerotier"
  ]

  # One rule per distinct port, since two worlds of the same game share it.
  public_game_ports = {
    for world in local.public_worlds : "${world.protocol}-${world.port}" => world...
  }
}

resource "aws_security_group" "game_host" {
  # AWS makes a security group's description immutable. Keep the legacy text
  # so adding catalog-driven public rules never replaces the group (and, by
  # dependency, the host). The ingress blocks below are the source of truth.
  name        = "spawnpoint-game-host"
  description = "ZeroTier-only game host; deliberately no inbound rules"
  vpc_id      = aws_vpc.main.id

  dynamic "ingress" {
    for_each = local.public_game_ports

    content {
      description = "Declared public world${length(ingress.value) > 1 ? "s" : ""}: ${join(", ", [for world in ingress.value : world.id])}"
      from_port   = ingress.value[0].port
      to_port     = ingress.value[0].port
      protocol    = ingress.value[0].protocol
      cidr_blocks = ["0.0.0.0/0"]
    }
  }

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

check "public_worlds_declare_their_authentication" {
  # The old rule was "zero ingress", which was the right guarantee while every
  # world used the overlay. The guarantee now is narrower and still absolute:
  # the only open ports are the game ports of worlds that say in the catalog
  # they are public — that part holds by construction, since the dynamic block
  # iterates exactly that local — and every such world must also declare how
  # its players are authenticated. Opening a port is a catalog diff, never a
  # Terraform edit.
  #
  # Asserted against the local rather than against the security group, because
  # a dynamically built ingress set is unknown until apply, and a check that
  # cannot be evaluated at plan time protects nothing.
  assert {
    condition     = alltrue([for world in local.public_worlds : contains(["external", "game"], world.auth)])
    error_message = "A world may only be published without the overlay if its catalog entry declares auth: external or auth: game (ADR-0033)."
  }
}
