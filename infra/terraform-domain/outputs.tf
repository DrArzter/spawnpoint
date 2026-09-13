output "domain_name" {
  description = "Delegated Spawnpoint domain owned by this hosted zone."
  value       = aws_route53_zone.primary.name
}

output "hosted_zone_id" {
  description = "Route 53 public hosted-zone identifier consumed by domain-attached services."
  value       = aws_route53_zone.primary.zone_id
}

output "name_servers" {
  description = "Authoritative nameservers to publish on the parent zone's spawnpoint NS record at Namecheap."
  value       = sort(aws_route53_zone.primary.name_servers)
}
