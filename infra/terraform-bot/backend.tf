terraform {
  # State bucket is created by ../terraform-bootstrap and supplied through backend.hcl.
  backend "s3" {}
}
