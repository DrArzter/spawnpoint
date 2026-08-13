# Persistent object storage

This Terraform root owns the world-backup and immutable-release buckets. It has a separate S3 state key because these
buckets outlive disposable game hosts and ordinary compute teardown.

Both buckets are private, versioned, bucket-owner-enforced, encrypted with SSE-S3 and reject non-TLS requests. The
backup bucket keeps deleted object versions for 30 days as a recovery window; current backup versions are selected by
the exact `5 daily / 2 weekly / 2 monthly` domain policy and have no age-based expiration. Both buckets have
`prevent_destroy`; destroying disposable compute cannot include them, and destroying this root requires a deliberate
code change.

Copy `backend.hcl.example` to ignored `backend.hcl`, use the real state bucket name, then run `terraform init
-backend-config=backend.hcl`. Apply this root before planning the compute root, which reads the resulting buckets but
does not own their lifecycle.
