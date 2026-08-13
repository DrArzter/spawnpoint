# infra/terraform

All AWS resources live here. Nothing is created by hand after M0, except the state backend itself.

Owns: VPC, subnet, internet gateway, route table, security group, EC2 instance and data volume, S3 buckets,
IAM roles and policies, Lambda functions, Step Functions state machines, API Gateway, EventBridge rules, SNS topic, DynamoDB table, Route 53
records, CloudFront distribution, CloudWatch alarms, AWS Budgets.

Does not own: mod releases, the world, or anything else that is data rather than infrastructure. Those belong
to the release pipeline. See [ADR-0011](../../docs/adr/0011-terraform-for-infrastructure.md) and
[ADR-0009](../../docs/adr/0009-s3-as-mod-source-of-truth.md).

Secrets are never variables or outputs here. They live in SSM Parameter Store, created outside Terraform and
referenced by name.

Start flat. Split into modules when a single configuration genuinely hurts, not before.

The first split that is justified is an environment root, not duplicated resources: production AWS and the opt-in
LocalStack environment consume the same modules where API coverage permits. Endpoint overrides, dummy credentials and
unsupported edge resources live in the local root. They must not leak into production variables or produce a second
copy of the state-machine definition. See
[ADR-0031](../../docs/adr/0031-first-class-local-control-plane.md).

State backend bootstrap is a one-time, separately stateful Terraform step in
[`../terraform-bootstrap`](../terraform-bootstrap/) — see
[the runbook](../../docs/runbook.md#bootstrap-terraform-state).

## Current slice

The current M1 slice defines 27 resources without applying them: one VPC, one public subnet and route, a zero-ingress
security group, an SSM-only EC2 role/profile, one on-demand EC2 host, one separately attached encrypted data EBS, and
private versioned buckets for world backups and mod releases. Both buckets block public access, require TLS, use
S3-managed encryption and discard abandoned multipart uploads. The physical AZ ID is asserted because the volume is
zonal. The instance has no SSH key and requires IMDSv2.

The game-host role can write and verify backup objects and read immutable release objects. It cannot change bucket
configuration or delete objects. Exact `5 daily / 2 weekly / 2 monthly` pruning belongs to the later backup operation:
S3 lifecycle deletes by object age, not by "keep the newest N" semantics, so pretending it implements that policy
would silently weaken the ADR.

`m7i-flex.large` is the default while the account remains on the Free Plan. `r8i-flex.large` is the reviewed 16 GiB
upgrade, but selecting it requires an explicit Paid Plan decision. The full-group memory measurement decides whether
that upgrade is needed; Terraform does not quietly make a billing-plan decision.

Terraform is run from its pinned official container, so no system installation is needed:

```bash
docker run --rm --user "$(id -u):$(id -g)" \
  -e HOME=/tmp/terraform-home \
  -v "$PWD:/workspace" \
  -w /workspace/infra/terraform \
  hashicorp/terraform:1.15.8 fmt -check -diff

docker run --rm --user "$(id -u):$(id -g)" \
  -e HOME=/tmp/terraform-home \
  -v "$PWD:/workspace" \
  -w /workspace/infra/terraform \
  hashicorp/terraform:1.15.8 init -backend=false

docker run --rm --user "$(id -u):$(id -g)" \
  -e HOME=/tmp/terraform-home \
  -v "$PWD:/workspace" \
  -w /workspace/infra/terraform \
  hashicorp/terraform:1.15.8 validate

docker run --rm --user "$(id -u):$(id -g)" \
  -e HOME=/tmp/terraform-home \
  -v "$PWD:/workspace" \
  -w /workspace/infra/terraform \
  hashicorp/terraform:1.15.8 test
```

The tests use Terraform's mock AWS provider: they require no credentials and cannot create resources. They assert the
Free Plan instance choice, zero ingress, IMDSv2, termination protection, root/data EBS semantics, private versioned
encrypted buckets, the reviewed paid upgrade and rejection of unreviewed instance types.

The committed S3 backend intentionally has no bucket name. The real ignored `backend.hcl` now points to the bootstrapped
production bucket; `backend.hcl.example` documents the shape without publishing account-specific configuration. Never
pass credentials through that file: Terraform can persist backend arguments in `.terraform/` and plan files. The
non-secret profile name belongs in it because the S3 backend is initialised before, and independently from, the AWS
provider configuration.

The complete `terraform plan` was exercised against real read-only AWS data sources on 2026-08-13: the current AL2023
AMI, account identity and `eu-central-1a` / `euc1-az2` resolved, and the result was **27 to add, 0 to change, 0 to
destroy**. It was not saved and cannot be applied. The same plan succeeded again through the real S3 backend and
exercised its native lockfile. The bootstrap was applied separately: its seven resources are live, their S3 controls
were verified through AWS APIs, and its final drift check returned `No changes`.

**Status:** the state backend is live. M1 compute, network and storage validate, pass mock tests and pass a real
read-only plan; the 27-resource production apply remains deliberately pending while the account stays on the Free Plan.
