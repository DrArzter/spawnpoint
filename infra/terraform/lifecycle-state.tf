resource "aws_dynamodb_table" "lifecycle_v2" {
  name         = "spawnpoint-lifecycle-v2"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "server_id"

  deletion_protection_enabled = true

  attribute {
    name = "server_id"
    type = "S"
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
    Name    = "spawnpoint-lifecycle-v2"
    Purpose = "lifecycle-v2-coordination"
  }
}

