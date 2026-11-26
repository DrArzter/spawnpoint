# ADR-0102, step 3: Spot for a launched host whose sessions are all cold, of
# games that declare it. The start workflow asks for Spot only while both this
# switch and the session volume are on, and falls back to on demand when Spot
# has no capacity.

locals {
  spot_template_vars = {
    spot = var.spot
  }
}

# EC2 launches Spot capacity through this service-linked role. The account has
# none until the first Spot request, and the start role may not create IAM
# roles, so Terraform creates it with the switch. Turning the switch off again
# deletes it; AWS refuses that while Spot instances still use it.
resource "aws_iam_service_linked_role" "spot" {
  count            = var.spot == "enabled" ? 1 : 0
  aws_service_name = "spot.amazonaws.com"
  description      = "EC2 Spot capacity for Spawnpoint launched hosts (ADR-0102)."
}
