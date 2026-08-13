# Terraform state bootstrap

This separate root creates the private, versioned S3 bucket used by the production Terraform backend. It deliberately
keeps local state: the backend cannot store the state describing its own bucket before that bucket exists.

Run it once, then copy `terraform output -raw state_bucket_name` into `../terraform/backend.hcl` and initialise the
production root with `terraform init -backend-config=backend.hcl`. The S3 backend uses native lockfiles, so no DynamoDB
table is required.

The bucket has `prevent_destroy`, all public access blocked, bucket-owner-enforced ownership, SSE-S3 encryption and a
policy denying non-TLS requests. The ignored local `terraform.tfstate` remains sensitive operational data: keep a
private copy until the bucket has been imported into a replacement bootstrap state and verified.

Do not run `terraform destroy` as ordinary cleanup. Removing the state bucket requires first emptying every object
version and deliberately removing `prevent_destroy`; that should never happen while a production state object exists.
