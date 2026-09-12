terraform {
  # State bucket is created by ../terraform-bootstrap and supplied through backend.hcl.
  # The pipeline trust anchor survives disposable host replacement, so it has its own state.
  backend "s3" {}
}
