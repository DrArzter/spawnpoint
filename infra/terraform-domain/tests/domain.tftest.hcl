mock_provider "aws" {
  override_during = plan
}

run "public_zone_is_stable_and_explicit" {
  command = plan

  variables {
    aws_profile = ""
    aws_region  = "eu-central-1"
    domain_name = "spawnpoint.example.dev"
  }

  assert {
    condition     = aws_route53_zone.primary.name == "spawnpoint.example.dev"
    error_message = "The domain must come from the caller rather than being inferred from a service name."
  }

  assert {
    condition     = aws_route53_zone.primary.force_destroy == false
    error_message = "The authoritative zone must refuse deletion while it contains records."
  }

  assert {
    condition     = aws_route53_zone.primary.tags["Purpose"] == "public-authoritative-dns"
    error_message = "The hosted zone must remain identifiable in the shared AWS account."
  }
}

run "a_missing_name_is_cached_as_missing_for_a_minute" {
  command = plan

  variables {
    aws_profile = ""
    aws_region  = "eu-central-1"
    domain_name = "spawnpoint.example.dev"
  }

  override_resource {
    target          = aws_route53_zone.primary
    override_during = plan
    values = {
      zone_id             = "Z123ABC"
      primary_name_server = "ns-1.awsdns-01.com"
    }
  }

  assert {
    condition     = aws_route53_record.soa.type == "SOA" && aws_route53_record.soa.allow_overwrite && endswith(one(aws_route53_record.soa.records), " 60")
    error_message = "The zone's SOA minimum is the negative-cache time; it stays at 60 seconds (ADR-0086)."
  }
}
