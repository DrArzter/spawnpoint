resource "aws_dynamodb_table" "lifecycle_v2" {
  name         = "spawnpoint-lifecycle-v2"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "server_id"

  deletion_protection_enabled = true

  attribute {
    name = "server_id"
    type = "S"
  }

  server_side_encryption {
    enabled = true
  }

  lifecycle {
    prevent_destroy = true
  }

  tags = {
    Name    = "spawnpoint-lifecycle-v2"
    Purpose = "lifecycle-v2-coordination"
  }
}

