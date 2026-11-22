# Persistent object storage

This Terraform root owns the world-backup and immutable-release buckets plus `spawnpoint-control-plane-view`, the
bounded event history and rebuildable current view described by
[ADR-0049](../../docs/adr/0049-project-control-plane-events-into-dynamodb.md). It has a separate S3 state key because
these records outlive disposable game hosts and ordinary compute teardown.

Both buckets are private, versioned, bucket-owner-enforced, encrypted with SSE-S3 and reject non-TLS requests. The
backup bucket keeps deleted object versions for 30 days as a recovery window; current backup versions are selected by
the exact `5 daily / 2 weekly / 2 monthly` domain policy and have no age-based expiration. Both buckets have
`prevent_destroy`; destroying disposable compute cannot include them, and destroying this root requires a deliberate
code change.

In the release bucket, no rule expires a current object under `releases/`. The one exception is `upstream/`, the
release builder's cache of verified upstream files: it expires 60 days after a write, bytes and index together, because
no release names these objects and CurseForge or a pinned mirror can supply them again.

Content-addressed releases ([ADR-0080](../../docs/adr/0080-store-release-files-by-content.md)) keep payload files and
packs under `objects/sha256/`, named by digest. The bucket policy lets only the role `spawnpoint-release-reconciler`
(`../terraform-operations`) delete an object there, and lets nobody delete an object version. A lifecycle rule expires
noncurrent object versions after 30 days and never expires a current object. `spawnpoint-release-refs` is the owner's
reference table: back-references of each object and holders of each release. It is on-demand, encrypted,
deletion-protected and has point-in-time recovery. Apply this root before the roots that read it.

The control-plane table is encrypted, deletion-protected and on-demand. Event records expire through TTL; projection
records do not.

Copy `backend.hcl.example` to ignored `backend.hcl`, use the real state bucket name, then run `terraform init
-backend-config=backend.hcl`. Apply this root before planning the compute root, which reads the resulting buckets but
does not own their lifecycle.
