terraform {
  # The bucket is bootstrapped once and supplied through backend.hcl.
  # Keep account-specific names out of the repository.
  backend "s3" {}
}

