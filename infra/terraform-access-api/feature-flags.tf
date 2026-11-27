# Feature flags the owner changes without a release (ADR-0107). Terraform
# creates the parameter once with no flags and never writes its value again:
# the owner sets it with `aws ssm put-parameter` or in the console.
locals {
  feature_flags_parameter_arn = "arn:aws:ssm:${var.aws_region}:${data.aws_caller_identity.current.account_id}:parameter${aws_ssm_parameter.feature_flags.name}"
}

resource "aws_ssm_parameter" "feature_flags" {
  name        = "/spawnpoint/flags"
  description = "Spawnpoint feature flags as JSON: {\"off\": [capability, ...], \"skins\": [skin, ...]} (ADR-0107)."
  type        = "String"
  value       = "{}"

  lifecycle {
    ignore_changes = [value]
  }

  tags = {
    Name    = "spawnpoint-feature-flags"
    Purpose = "feature-flags"
  }
}
