terraform {
  # State bucket is created by ../terraform-bootstrap and supplied through backend.hcl.
  # Account-specific names stay out of the repository.
  backend "s3" {}
}
