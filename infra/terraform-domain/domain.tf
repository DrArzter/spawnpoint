resource "aws_route53_zone" "primary" {
  name          = var.domain_name
  comment       = "Delegated authoritative DNS for ${var.domain_name}; parent DNS remains at Namecheap"
  force_destroy = false

  tags = {
    Name    = var.domain_name
    Purpose = "public-authoritative-dns"
  }

  lifecycle {
    prevent_destroy = true
  }
}
