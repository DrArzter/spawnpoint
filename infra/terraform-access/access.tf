resource "aws_dynamodb_table" "access" {
  name         = "spawnpoint-access"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"
  range_key    = "sk"

  deletion_protection_enabled = true

  attribute {
    name = "pk"
    type = "S"
  }

  attribute {
    name = "sk"
    type = "S"
  }

  attribute {
    name = "gsi1pk"
    type = "S"
  }

  attribute {
    name = "gsi1sk"
    type = "S"
  }

  global_secondary_index {
    name            = "gsi1"
    hash_key        = "gsi1pk"
    range_key       = "gsi1sk"
    projection_type = "ALL"
  }

  point_in_time_recovery {
    enabled = true
  }

  ttl {
    attribute_name = "ttl"
    enabled        = true
  }

  # Encrypted at rest with the AWS owned key (ADR-0101): the AWS managed key cost a KMS request per caller every
  # five minutes.
  server_side_encryption {
    enabled = false
  }

  lifecycle {
    prevent_destroy = true
  }

  tags = {
    Name    = "spawnpoint-access"
    Purpose = "identity-access-and-onboarding"
  }
}
