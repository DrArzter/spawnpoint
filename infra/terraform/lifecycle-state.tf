resource "aws_dynamodb_table" "lifecycle_v2" {
  name         = "spawnpoint-lifecycle-v2"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "server_id"

  deletion_protection_enabled = true

  # Session record changes tell open panels to reload (ADR-0104). The filter
  # reads the record's state and the handler compares it with the old one, so
  # the stream carries both images. Enabling a stream updates the table in place.
  stream_enabled   = true
  stream_view_type = "NEW_AND_OLD_IMAGES"

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

