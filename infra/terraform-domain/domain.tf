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

# ADR-0086: a resolver caches "no such name" for min(SOA TTL, SOA minimum).
# Route 53's default minimum is a day, so a world name looked up before it ever
# existed stayed missing for 15 minutes after its first start. Every other
# field keeps Route 53's own value.
resource "aws_route53_record" "soa" {
  zone_id         = aws_route53_zone.primary.zone_id
  name            = aws_route53_zone.primary.name
  type            = "SOA"
  ttl             = 900
  allow_overwrite = true
  records         = ["${aws_route53_zone.primary.primary_name_server}. awsdns-hostmaster.amazon.com. 1 7200 900 1209600 60"]
}
