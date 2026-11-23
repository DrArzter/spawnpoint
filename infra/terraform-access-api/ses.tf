# Amazon SES as the transactional email adapter: the sender's domain is an SES
# identity in this account, so no third-party account or API key is needed.
# DKIM records are written only when the sender's domain is inside the zone
# this root already manages; otherwise the tokens are an output for the owner.
#
# A new account starts in the SES sandbox: mail reaches verified addresses
# only, until AWS grants production access. That request is the owner's.

locals {
  ses_enabled       = var.email_delivery_provider == "ses"
  ses_sender_domain = local.ses_enabled ? lower(regex("@([^@>[:space:]]+)>?$", trimspace(var.email_from))[0]) : ""
  ses_zone_name     = var.dns_zone_name == null ? "" : lower(trimsuffix(var.dns_zone_name, "."))
  ses_in_zone       = local.ses_sender_domain == local.ses_zone_name || endswith(local.ses_sender_domain, ".${local.ses_zone_name}")
  ses_dkim_in_zone  = local.ses_enabled && local.ses_zone_name != "" && local.ses_in_zone
  ses_identity_arn  = "arn:aws:ses:${var.aws_region}:${data.aws_caller_identity.current.account_id}:identity/${local.ses_sender_domain}"
}

resource "aws_sesv2_email_identity" "sender" {
  count          = local.ses_enabled ? 1 : 0
  email_identity = local.ses_sender_domain

  # Easy DKIM with the longer key; SES returns the three tokens after apply.
  dkim_signing_attributes {
    next_signing_key_length = "RSA_2048_BIT"
  }
}

data "aws_route53_zone" "email" {
  count        = local.ses_dkim_in_zone ? 1 : 0
  name         = local.ses_zone_name
  private_zone = false
}

resource "aws_route53_record" "ses_dkim" {
  count   = local.ses_dkim_in_zone ? 3 : 0
  zone_id = data.aws_route53_zone.email[0].zone_id
  name    = "${aws_sesv2_email_identity.sender[0].dkim_signing_attributes[0].tokens[count.index]}._domainkey.${local.ses_sender_domain}"
  type    = "CNAME"
  ttl     = 1800
  records = ["${aws_sesv2_email_identity.sender[0].dkim_signing_attributes[0].tokens[count.index]}.dkim.amazonses.com"]
}
