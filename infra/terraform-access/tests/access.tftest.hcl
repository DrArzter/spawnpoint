mock_provider "aws" {
  override_during = plan
}

run "access_state_is_protected_on_demand_and_queryable_by_review_state" {
  command = plan

  assert {
    condition     = aws_dynamodb_table.access.billing_mode == "PAY_PER_REQUEST"
    error_message = "A tiny access directory must not reserve DynamoDB capacity."
  }

  assert {
    condition     = aws_dynamodb_table.access.hash_key == "pk" && aws_dynamodb_table.access.range_key == "sk"
    error_message = "The shared access table uses the reviewed entity/item key contract."
  }

  assert {
    condition     = one(aws_dynamodb_table.access.global_secondary_index).name == "gsi1"
    error_message = "Owners need exactly the reviewed index for candidate and identity listings."
  }

  assert {
    condition     = aws_dynamodb_table.access.deletion_protection_enabled && aws_dynamodb_table.access.point_in_time_recovery[0].enabled
    error_message = "Identity and access state must survive an accidental infrastructure change."
  }

  assert {
    condition     = aws_dynamodb_table.access.server_side_encryption[0].enabled
    error_message = "Observed external account identifiers must be encrypted at rest."
  }

  assert {
    condition     = aws_dynamodb_table.access.ttl[0].enabled && aws_dynamodb_table.access.ttl[0].attribute_name == "ttl"
    error_message = "Expired login-session records must be eligible for DynamoDB TTL cleanup."
  }
}
